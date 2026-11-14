#!/usr/bin/env node
// Isolated runtime preparation and opt-in readiness checks. No third-party JS dependencies.
import { spawn } from 'node:child_process';
import { access, copyFile, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readServerConfig, StdioClient } from './stdio.mjs';
import { compareCatalogs } from './schema-diff.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const readJSON = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const samePath = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const exists = async file => { try { await lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const inside = (parent, child) => { const path = relative(parent, child); return path === '' || (!path.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && path !== '..' && !isAbsolute(path)); };
const excluded = name => ['.git', '.venv', 'venv', '__pycache__', 'node_modules', '.aws', '.ssh', '.pytest_cache', '.mypy_cache'].includes(name)
  || name.startsWith('.env') || name.endsWith('.pyc') || name.endsWith('.pyo') || name.endsWith('.egg-info');

export async function findExecutable(command, base, env = process.env) {
  const direct = isAbsolute(command) || /[\\/]/.test(command);
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH');
  const roots = direct ? [resolve(base, command)] : (env[pathKey] ?? '').split(delimiter).filter(Boolean).map(dir => resolve(base, dir, command));
  const suffixes = process.platform === 'win32' && !extname(command) ? ['', '.exe', '.com'] : [''];
  for (const root of roots) for (const suffix of suffixes) {
    const candidate = root + suffix;
    try {
      if (!(await stat(candidate)).isFile()) continue;
      if (process.platform !== 'win32') await access(candidate, constants.X_OK);
      if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(candidate)) continue;
      return candidate;
    } catch { /* Try next PATH entry. */ }
  }
  return null;
}

async function killTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); } return; }
  await new Promise(done => {
    const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { killer.kill(); child.kill(); done(); }, 3000);
    killer.once('error', () => { clearTimeout(timer); child.kill(); done(); });
    killer.once('exit', () => { clearTimeout(timer); child.kill(); done(); });
  });
}

export function runBounded(command, args, { cwd, env = process.env, timeoutMs = 30000 } = {}) {
  return new Promise(done => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', reason = null, finished = false;
    const finish = code => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      done({ code, reason, stdout, stderr });
    };
    const stop = async why => {
      if (reason || finished) return;
      reason = why;
      await killTree(child);
      child.stdout.destroy(); child.stderr.destroy();
      finish(null);
    };
    const timer = setTimeout(() => { void stop('timeout'); }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) void stop('output_limit'); });
    child.stderr.on('data', data => { if (stderr.length < 256000) stderr += data.slice(0, 256000 - stderr.length); });
    child.once('error', () => { reason = 'launch_failed'; finish(null); });
    child.once('close', finish);
  });
}

function diagnostic(result) {
  if (result.reason === 'timeout') return 'Timed out. Check startup work, blocked loopback/event-loop setup, and environment permissions before treating this as a version regression.';
  if (result.reason === 'launch_failed') return 'Executable could not start. Verify the interpreter still exists and is usable; a stale venv can point at a removed base interpreter.';
  if (result.reason === 'output_limit') return 'Process exceeded the bounded output limit.';
  if (/10013|PermissionError|permission denied|access is denied|operation not permitted/i.test(result.stderr)) return 'The process reported a permission failure. Check sandbox and loopback restrictions; no automatic privilege change was attempted.';
  if (/dns|No such host|Name or service not known|Failed to fetch|network is unreachable/i.test(result.stderr)) return 'Dependency network access failed. Check allowed package-index connectivity; no alternate index was selected.';
  if (/No solution found|No matching distribution|not found in the package registry|ResolutionImpossible/i.test(result.stderr)) return 'Dependency resolution failed. Check exact version pins and include every required local package, including separately distributed core/shared packages.';
  return `Process failed with exit code ${result.code ?? 'unknown'}. Raw output was omitted because it may contain credentials or local data.`;
}

const PYTHON_PROBE = `import contextlib,importlib,importlib.metadata as metadata,io,json,platform,struct,sys
result={'version':platform.python_version(),'implementation':platform.python_implementation(),'bits':struct.calcsize('P')*8,'imports':[]}
mapping=metadata.packages_distributions()
for name in json.loads(sys.argv[1]):
    entry={'name':name,'status':'ok','distributions':{}}
    try:
        with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            importlib.import_module(name)
        entry['distributions']={dist:metadata.version(dist) for dist in mapping.get(name.split('.')[0],[])}
    except BaseException as error:
        entry={'name':name,'status':'failed','errorType':type(error).__name__}
    result['imports'].append(entry)
print('MCP_RUNTIME_PROBE='+json.dumps(result))`;

export async function doctor(configFile, { python = false, imports = [], smoke = false, timeoutMs = 10000 } = {}) {
  if (imports.some(name => !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(name))) throw new Error('Import names must be dotted Python module names.');
  if (imports.length && !python) throw new Error('--imports requires --python.');
  const config = await readServerConfig(configFile);
  const report = { formatVersion: 1, mode: 'doctor', status: 'launch_not_tested', checks: [], executed: { pythonProbe: false, serverSmoke: false }, limitations: ['Filesystem checks cannot prove that a program starts.', 'Smoke only initializes and lists tools; server startup itself may have side effects.', 'Environment failures do not establish an upgrade regression. Raw logs, arguments, and environment values are not included.'] };
  let cwdOK = false;
  try { cwdOK = (await stat(config.cwd)).isDirectory(); } catch { /* Report below. */ }
  report.checks.push({ check: 'working_directory', status: cwdOK ? 'ok' : 'failed', path: config.cwd });
  const executable = await findExecutable(config.command, dirname(resolve(configFile)), config.env);
  report.checks.push({ check: 'executable', status: executable ? 'ok' : 'failed', ...(executable ? { path: executable } : {}), ...(!executable ? { detail: 'Direct executable not found. Shell wrappers are not supported.' } : {}) });
  if (!cwdOK || !executable) { report.status = 'not_ready'; return report; }
  if (python) {
    report.executed.pythonProbe = true;
    const result = await runBounded(executable, ['-I', '-B', '-c', PYTHON_PROBE, JSON.stringify(imports)], { cwd: config.cwd, env: config.env, timeoutMs });
    const marker = result.stdout.split(/\r?\n/).findLast(line => line.startsWith('MCP_RUNTIME_PROBE='));
    let info;
    try { if (marker) info = JSON.parse(marker.slice('MCP_RUNTIME_PROBE='.length)); } catch { /* Invalid probe output. */ }
    if (result.code !== 0 || !object(info) || !Array.isArray(info.imports)) {
      report.checks.push({ check: 'python', status: 'failed', detail: diagnostic(result) }); report.status = 'not_ready'; return report;
    }
    report.python = info;
    const failed = info.imports.some(entry => entry.status !== 'ok');
    report.checks.push({ check: 'python', status: failed ? 'failed' : 'ok', detail: failed ? 'One or more explicit imports failed. Rebuild this version in its own interpreter environment.' : 'Interpreter and requested imports completed.' });
    if (failed) { report.status = 'not_ready'; return report; }
  }
  if (smoke) {
    report.executed.serverSmoke = true;
    const client = new StdioClient({ ...config, command: executable }, timeoutMs);
    let stderr = '';
    client.child.stderr.on('data', data => { if (stderr.length < 256000) stderr += data.toString().slice(0, 256000 - stderr.length); });
    const timer = setTimeout(() => client.fail('Overall runtime smoke timeout.'), timeoutMs);
    try {
      const identity = await client.initialize();
      const tools = await client.listTools();
      compareCatalogs(tools, tools);
      report.checks.push({ check: 'initialize_and_list_tools', status: 'ok', protocolVersion: identity.protocolVersion, toolCount: tools.length });
      report.status = 'smoke_passed';
    } catch (error) {
      report.checks.push({ check: 'initialize_and_list_tools', status: 'failed', detail: diagnostic({ stderr, reason: /timeout|timed out/i.test(error.message) ? 'timeout' : null, code: client.child.exitCode }) });
      report.status = 'not_ready';
    } finally {
      clearTimeout(timer);
      // taskkill may return just before Windows releases the child's cwd handle.
      const closed = new Promise(done => {
        if (!client.child.pid || client.child.exitCode !== null || client.child.signalCode !== null) { done(); return; }
        const expiry = setTimeout(done, 1500);
        client.child.once('close', () => { clearTimeout(expiry); done(); });
      });
      await client.close();
      await closed;
    }
  }
  return report;
}

function keys(value, allowed, name) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${name} has an unknown field or is not an object.`);
}
const pinned = line => /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9._,-]+\])?==[A-Za-z0-9][A-Za-z0-9.!+_-]*$/.test(line);

export async function planRuntime(manifestFile) {
  const manifest = await readJSON(manifestFile), base = dirname(resolve(manifestFile));
  keys(manifest, ['formatVersion', 'runtimeDir', 'python', 'uv', 'packages', 'requirements', 'lockFile', 'server', 'timeoutMs'], 'Manifest');
  if (manifest.formatVersion !== 1) throw new Error('Manifest formatVersion must be 1.');
  for (const field of ['runtimeDir', 'python']) if (typeof manifest[field] !== 'string' || !manifest[field].trim()) throw new Error(`Manifest ${field} is required.`);
  if (manifest.uv !== undefined && (typeof manifest.uv !== 'string' || !manifest.uv.trim())) throw new Error('Manifest uv must be an executable name or path.');
  if (!Array.isArray(manifest.packages) || !manifest.packages.length) throw new Error('Manifest packages must be a nonempty array.');
  const runtimeDir = resolve(base, manifest.runtimeDir);
  if (await exists(runtimeDir)) throw new Error('Runtime destination already exists. Choose a fresh directory; existing environments are never modified.');
  // Resolve the nearest existing parent so a junction cannot hide a source/destination overlap.
  let ancestor = dirname(runtimeDir);
  while (!(await exists(ancestor))) ancestor = dirname(ancestor);
  const canonicalRuntime = resolve(await realpath(ancestor), relative(ancestor, runtimeDir));
  const names = new Set(), packages = [];
  for (const pkg of manifest.packages) {
    keys(pkg, ['name', 'path'], 'Package');
    if (typeof pkg.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(pkg.name) || names.has(pkg.name.toLowerCase())) throw new Error('Package names must be unique simple directory names.');
    if (typeof pkg.path !== 'string' || !pkg.path.trim()) throw new Error('Package path is required.');
    names.add(pkg.name.toLowerCase());
    const source = resolve(base, pkg.path), sourceStat = await lstat(source);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('Package sources must be materialized directories, not symbolic links.');
    const canonicalSource = await realpath(source);
    if (inside(canonicalSource, canonicalRuntime) || inside(canonicalRuntime, canonicalSource)) throw new Error('Runtime destination and package source must not contain one another.');
    if (!(await exists(join(source, 'pyproject.toml'))) && !(await exists(join(source, 'setup.py')))) throw new Error('Local package has no pyproject.toml or setup.py. Include the actual package directory.');
    packages.push({ name: pkg.name, source, destination: join(runtimeDir, 'source', pkg.name) });
  }
  let requirements = manifest.requirements ?? [];
  if (!Array.isArray(requirements) || requirements.some(line => typeof line !== 'string' || !pinned(line))) throw new Error('Requirements must be exact name==version pins; URLs, options, ranges, and wildcard versions are not accepted.');
  if (manifest.lockFile !== undefined) {
    if (typeof manifest.lockFile !== 'string') throw new Error('lockFile must be a path.');
    const lines = (await readFile(resolve(base, manifest.lockFile), 'utf8')).replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    if (lines.some(line => !pinned(line))) throw new Error('Lock file must contain exact package pins only. Local packages belong in packages, not the lock file.');
    requirements = [...requirements, ...lines];
  }
  keys(manifest.server, ['module', 'args', 'env'], 'Server');
  if (typeof manifest.server.module !== 'string' || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(manifest.server.module)) throw new Error('Server module must be a dotted Python module name.');
  if (manifest.server.args !== undefined && (!Array.isArray(manifest.server.args) || manifest.server.args.some(arg => typeof arg !== 'string'))) throw new Error('Server args must be strings.');
  if (manifest.server.env !== undefined && (!object(manifest.server.env) || Object.values(manifest.server.env).some(value => typeof value !== 'string'))) throw new Error('Server env must map names to nonsecret strings.');
  const timeoutMs = manifest.timeoutMs ?? 180000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900000) throw new Error('Manifest timeoutMs must be from 1000 to 900000 per build step.');
  const python = await findExecutable(manifest.python, base), uv = await findExecutable(manifest.uv ?? 'uv', base);
  const plan = { formatVersion: 1, mode: 'prepare', status: python && uv ? 'planned' : 'prerequisite_missing', runtimeDir, python, uv,
    packages, requirements: [...new Set(requirements)], serverModule: manifest.server.module,
    environmentKeys: Object.keys(manifest.server.env ?? {}), timeoutMs,
    excluded: ['.git', '.venv', 'venv', '__pycache__', 'node_modules', '.aws', '.ssh', '.env*', '*.pyc', '*.pyo', '*.egg-info', '.pytest_cache', '.mypy_cache'],
    effects: ['Copy local sources; never edit originals.', 'Create an isolated venv and cache within runtimeDir.', 'Install explicit local packages and their dependencies from PyPI; build backends execute code.', 'Write source hashes, an external dependency lock, setup status, and server.json; do not launch the server.'] };
  return { plan, manifest };
}

async function copySources(source, target, prefix = '', inventory = []) {
  await mkdir(target, { recursive: true });
  for (const entry of (await readdir(source)).sort()) {
    if (excluded(entry)) continue;
    const from = join(source, entry), to = join(target, entry), info = await lstat(from);
    if (info.isSymbolicLink()) throw new Error('Source contains a symbolic link or junction. Materialize it before preparing a runtime.');
    if (info.isDirectory()) await copySources(from, to, prefix + entry + '/', inventory);
    else if (info.isFile()) {
      await copyFile(from, to, constants.COPYFILE_EXCL);
      const sha256 = createHash('sha256').update(await readFile(to)).digest('hex');
      inventory.push({ path: prefix + entry, sha256 });
    } else throw new Error('Source contains a nonregular file.');
  }
  return inventory;
}

export async function prepareRuntime(manifestFile, { apply = false, run = runBounded } = {}) {
  const { plan, manifest } = await planRuntime(manifestFile);
  if (!apply) return plan;
  if (!plan.python || !plan.uv) throw new Error('Required Python or uv executable is unavailable. No runtime was created.');
  // Exclusive mkdir is the mutation boundary; a racing or pre-existing destination is never reused.
  await mkdir(dirname(plan.runtimeDir), { recursive: true });
  await mkdir(plan.runtimeDir);
  const stateFile = join(plan.runtimeDir, 'setup-status.json');
  const state = { formatVersion: 1, status: 'preparing', stage: 'copy_sources' };
  const saveState = () => writeFile(stateFile, JSON.stringify(state, null, 2) + '\n');
  await saveState();
  try {
    const sources = [];
    for (const pkg of plan.packages) sources.push({ name: pkg.name, files: await copySources(pkg.source, pkg.destination) });
    await writeFile(join(plan.runtimeDir, 'source-hashes.json'), JSON.stringify(sources, null, 2) + '\n');
    await writeFile(join(plan.runtimeDir, 'requirements.input.txt'), plan.requirements.join('\n') + '\n');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('UV_')));
    Object.assign(env, { UV_NO_PROGRESS: '1', UV_PYTHON_DOWNLOADS: 'never', UV_LINK_MODE: 'copy' });
    const common = ['--no-config', '--cache-dir', join(plan.runtimeDir, 'cache')];
    const venv = join(plan.runtimeDir, 'venv');
    const runtimePython = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const step = async (name, args) => {
      state.stage = name; await saveState();
      const result = await run(plan.uv, [...common, ...args], { cwd: plan.runtimeDir, env, timeoutMs: plan.timeoutMs });
      if (result.code !== 0) throw new Error(`${name}: ${diagnostic(result)}`);
      return result;
    };
    await step('create_venv', ['venv', '--python', plan.python, venv]);
    await step('install_packages', ['pip', 'install', '--python', runtimePython, '--default-index', 'https://pypi.org/simple', '--requirements', join(plan.runtimeDir, 'requirements.input.txt'), ...plan.packages.flatMap(pkg => ['--editable', pkg.destination])]);
    const frozen = await step('record_versions', ['pip', 'freeze', '--python', runtimePython, '--exclude-editable']);
    const lock = frozen.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lock.some(line => !pinned(line))) throw new Error('Installed dependencies include a non-pinned or direct-reference entry; automatic lock recording cannot represent it.');
    await writeFile(join(plan.runtimeDir, 'requirements.lock.txt'), lock.sort().join('\n') + '\n');
    const config = { command: runtimePython, args: ['-m', manifest.server.module, ...(manifest.server.args ?? [])], cwd: plan.runtimeDir, env: { PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', ...(manifest.server.env ?? {}) } };
    await writeFile(join(plan.runtimeDir, 'server.json'), JSON.stringify(config, null, 2) + '\n');
    state.status = 'prepared'; state.stage = 'complete'; await saveState();
    return { ...plan, status: 'prepared', serverConfig: join(plan.runtimeDir, 'server.json'), dependencyLock: join(plan.runtimeDir, 'requirements.lock.txt'), serverLaunched: false };
  } catch (error) {
    state.status = 'failed'; state.detail = error.message; await saveState();
    throw new Error(`Runtime preparation failed during ${state.stage}. Partial files were retained for inspection; choose a fresh destination for a retry. ${error.message}`);
  }
}

export async function main(args) {
  const [mode, ...rest] = args;
  if (!mode || mode === '--help' || mode === '-h') {
    console.log('Runtime readiness and isolated Python setup\n\ndoctor --config server.json [--python --imports fastmcp,jsonschema,yaml] [--smoke] [--timeout-ms 10000] [--out readiness.json]\nprepare --manifest runtime.json [--apply]\n\nDoctor is filesystem-only by default. --python executes the configured interpreter and requested imports. --smoke launches the server, initializes, and lists tools. Prepare is a plan by default; --apply installs into a fresh isolated directory and never launches the server.\nExit: 0 checks/plan passed; 2 invalid input/setup failure; 3 readiness or prerequisite failure.');
    return 0;
  }
  if (!['doctor', 'prepare'].includes(mode)) throw new Error('Choose doctor or prepare.');
  const allowed = new Set(mode === 'doctor' ? ['config', 'python', 'imports', 'smoke', 'timeout-ms', 'out'] : ['manifest', 'apply']);
  const flags = new Set(['python', 'smoke', 'apply']), options = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i].startsWith('--') ? rest[i].slice(2) : '';
    if (!allowed.has(key) || Object.hasOwn(options, key)) throw new Error('Unknown or duplicate runtime option.');
    if (flags.has(key)) options[key] = true;
    else { if (!rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error('Runtime option needs a value.'); options[key] = rest[++i]; }
  }
  let result;
  if (mode === 'prepare') {
    if (!options.manifest) throw new Error('--manifest is required.');
    result = await prepareRuntime(options.manifest, { apply: options.apply });
  } else {
    if (!options.config) throw new Error('--config is required.');
    if (options.out && (samePath(options.out, options.config) || ((await exists(options.out)) && samePath(await realpath(options.out), await realpath(options.config))))) throw new Error('Doctor output must not overwrite its input config.');
    const timeoutMs = Number(options['timeout-ms'] ?? 10000);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) throw new Error('timeout-ms must be 100 to 300000.');
    result = await doctor(options.config, { python: options.python, imports: options.imports ? options.imports.split(',') : [], smoke: options.smoke, timeoutMs });
    if (options.out) { await mkdir(dirname(resolve(options.out)), { recursive: true }); await writeFile(options.out, JSON.stringify(result, null, 2) + '\n'); }
  }
  if (options.out) console.log(`${result.status}: ${result.checks.filter(check => check.status === 'failed').length} failed readiness checks. Report written.`);
  else console.log(JSON.stringify(result, null, 2));
  return ['not_ready', 'prerequisite_missing'].includes(result.status) ? 3 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
  console.error(error instanceof SyntaxError ? 'Invalid runtime JSON input.' : error.code ? `Runtime input/output failure (${error.code}).` : error.message);
  process.exitCode = 2;
});
