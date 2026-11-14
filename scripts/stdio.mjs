import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

const VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const MAX_MESSAGE = 16 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function readServerConfig(file) {
  const config = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  if (!object(config) || Object.keys(config).some(k => !['command', 'args', 'cwd', 'env'].includes(k)))
    throw new Error('Server config must contain command, optional args, cwd, and env only.');
  if (typeof config.command !== 'string' || !config.command.trim()) throw new Error('Server command must be a nonempty string.');
  if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some(a => typeof a !== 'string')))
    throw new Error('Server args must be an array of strings.');
  if (config.cwd !== undefined && typeof config.cwd !== 'string') throw new Error('Server cwd must be a string.');
  if (config.env !== undefined && (!object(config.env) || Object.values(config.env).some(v => typeof v !== 'string')))
    throw new Error('Server env must map names to string values. Inherit credentials instead.');
  const base = dirname(resolve(file));
  const cwd = resolve(base, config.cwd ?? '.');
  // Resolve paths, but leave bare executable names for PATH lookup. Never invoke a shell.
  const command = isAbsolute(config.command) || !/[\\/]/.test(config.command)
    ? config.command : resolve(base, config.command);
  return { command, args: config.args ?? [], cwd, env: { ...process.env, ...config.env } };
}

export class StdioClient {
  constructor(config, timeout = 10000) {
    this.timeout = timeout;
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = '';
    this.fatal = null;
    this.catalogChanges = 0;
    this.closing = false;
    this.child = spawn(config.command, config.args, {
      cwd: config.cwd, env: config.env, shell: false, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.receive(chunk));
    // Drain stderr without persisting server logs, which may contain credentials or user data.
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.fail('Server input stream closed.'));
    this.child.on('error', () => this.fail('Server could not start; check executable, cwd, and permissions.'));
    this.child.on('exit', () => { if (!this.closing) this.fail('Server exited before the session completed.'); });
  }

  fail(message) {
    if (this.fatal) return;
    this.fatal = new Error(message);
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(this.fatal); }
    this.pending.clear();
  }

  receive(chunk) {
    if (this.fatal) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_MESSAGE) { this.fail('Server message exceeded the 16 MiB limit.'); return; }
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line || this.fatal) continue;
      let message;
      try { message = JSON.parse(line); } catch { this.fail('Server wrote non-JSON data to stdout.'); return; }
      if (!object(message) || message.jsonrpc !== '2.0') { this.fail('Server sent an invalid JSON-RPC message.'); return; }
      if (typeof message.method === 'string') {
        if (message.method === 'notifications/tools/list_changed') this.catalogChanges++;
        if (Object.hasOwn(message, 'id')) this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client capability not supported.' } });
        continue;
      }
      const request = this.pending.get(message.id);
      if (!request) { this.fail('Server returned an unexpected response id.'); return; }
      if (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) {
        this.fail('Server response must contain exactly one of result or error.'); return;
      }
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      request.resolve(message);
    }
  }

  send(message) {
    if (this.fatal) throw this.fatal;
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method, params = {}) {
    if (this.fatal) return Promise.reject(this.fatal);
    const id = ++this.nextId;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => this.fail('Server request timed out; remaining calls were not attempted.'), this.timeout);
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      try { this.send({ jsonrpc: '2.0', id, method, params }); }
      catch { this.fail('Could not write the server request.'); }
    });
  }

  async initialize() {
    const message = await this.request('initialize', {
      protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: { name: 'mcp-upgrade-check', version: '0.1.0' },
    });
    const result = message.result;
    if (!object(result) || !VERSIONS.has(result.protocolVersion) || !object(result.capabilities) || !object(result.serverInfo)
        || typeof result.serverInfo.name !== 'string' || typeof result.serverInfo.version !== 'string')
      throw new Error('Initialization failed or returned an unsupported protocol version.');
    if (!object(result.capabilities.tools)) throw new Error('Server did not advertise tools capability.');
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return { protocolVersion: result.protocolVersion, serverInfo: { name: result.serverInfo.name, version: result.serverInfo.version } };
  }

  async listTools() {
    const tools = [], cursors = new Set();
    let cursor;
    for (let page = 0; page < 100; page++) {
      const response = await this.request('tools/list', cursor === undefined ? {} : { cursor });
      if (!object(response.result) || !Array.isArray(response.result.tools)) throw new Error('tools/list did not return a tool catalog.');
      tools.push(...response.result.tools);
      cursor = response.result.nextCursor;
      if (cursor === undefined) return tools;
      if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new Error('tools/list returned an invalid or repeated pagination cursor.');
      cursors.add(cursor);
    }
    throw new Error('tools/list exceeded 100 pages; catalog is incomplete.');
  }

  async close() {
    this.closing = true;
    this.fail('Session closed.');
    if (!this.child.pid || this.child.exitCode !== null || this.child.signalCode !== null) return;
    if (process.platform === 'win32') {
      // Kill only the tree we launched. No shell, command concatenation, or visible window.
      await new Promise(resolveClose => {
        const killer = spawn('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        const timer = setTimeout(() => { killer.kill(); this.child.kill(); resolveClose(); }, 3000);
        killer.on('error', () => { clearTimeout(timer); this.child.kill(); resolveClose(); });
        killer.on('exit', () => { clearTimeout(timer); this.child.kill(); resolveClose(); });
      });
    } else {
      try { process.kill(-this.child.pid, 'SIGKILL'); } catch { this.child.kill(); }
    }
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }
}
