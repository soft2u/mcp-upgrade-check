import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { doctor, findExecutable, main, planRuntime, prepareRuntime, runBounded } from '../scripts/runtime.mjs';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'mcp-runtime-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(base)), resolve(tmpdir()));
    assert.ok(base.includes('mcp-runtime-test-'));
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const source = join(base, 'package');
  await mkdir(source);
  await writeFile(join(source, 'pyproject.toml'), '[project]\nname="demo-runtime-package"\nversion="1.0.0"\n');
  await writeFile(join(source, 'demo.py'), 'answer = 42\n');
  const manifest = { formatVersion: 1, runtimeDir: './runtime', python: process.execPath, uv: process.execPath,
    packages: [{ name: 'demo', path: './package' }], requirements: ['demo-dependency==1.2.3'],
    server: { module: 'demo', args: ['--config', '/reviewed/config.yaml'], env: { APP_ENV: 'test', SENTINEL: 'not-for-report' } } };
  const path = join(base, 'runtime.json');
  const save = () => writeFile(path, JSON.stringify(manifest));
  await save();
  return { base, source, manifest, path, save };
}

async function config(t, script) {
  const f = await fixture(t), server = join(f.base, 'server.mjs'), path = join(f.base, 'server.json');
  await writeFile(server, script);
  await writeFile(path, JSON.stringify({ command: process.execPath, args: [server], cwd: f.base, env: { TEST_SECRET: 'do-not-publish-this-value' } }));
  return { ...f, server, config: path };
}

test('doctor default checks paths without executing the configured program or leaking env values', async t => {
  const f = await config(t, 'import {writeFileSync} from "node:fs"; writeFileSync("ran", "yes");');
  const report = await doctor(f.config);
  assert.equal(report.status, 'launch_not_tested');
  assert.deepEqual(report.executed, { pythonProbe: false, serverSmoke: false });
  assert.equal(report.checks.every(check => check.status === 'ok'), true);
  assert.equal((await readdir(f.base)).includes('ran'), false);
  assert.equal(JSON.stringify(report).includes('do-not-publish-this-value'), false);
});

test('doctor identifies missing executable and working directory without launching', async t => {
  const f = await fixture(t), path = join(f.base, 'server.json');
  await writeFile(path, JSON.stringify({ command: join(f.base, 'absent-python.exe'), cwd: join(f.base, 'absent-cwd') }));
  const result = await doctor(path, { smoke: true });
  assert.equal(result.status, 'not_ready');
  assert.equal(result.executed.serverSmoke, false);
  assert.equal(result.checks.filter(c => c.status === 'failed').length, 2);
});

test('imports require explicit Python probe and valid dotted names', async t => {
  const f = await config(t, '');
  await assert.rejects(doctor(f.config, { imports: ['json'] }), /requires --python/);
  await assert.rejects(doctor(f.config, { python: true, imports: ['os;print(1)'] }), /dotted Python/);
});

test('doctor CLI refuses to overwrite the input config, including Windows case variants', async t => {
  const f = await config(t, '');
  await assert.rejects(main(['doctor', '--config', f.config, '--out', f.config]), /must not overwrite/);
  if (process.platform === 'win32') await assert.rejects(main(['doctor', '--config', f.config, '--out', f.config.toUpperCase()]), /must not overwrite/);
});

test('findExecutable locates a direct executable but not a nonexistent executable', async () => {
  assert.equal(await findExecutable(process.execPath, process.cwd()), process.execPath);
  assert.equal(await findExecutable('not-a-real-mcp-executable-629624', process.cwd(), {}), null);
});

const SERVER = `import {createInterface} from 'node:readline';
let initialized=false;
for await (const line of createInterface({input:process.stdin})) {
 const req=JSON.parse(line); if(req.method==='notifications/initialized') {initialized=true;continue;}
 let result;
 if(req.method==='initialize') result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
 else if(req.method==='tools/list' && initialized) result=req.params?.cursor==='next'?{tools:[{name:'b',inputSchema:{type:'object'}}]}:{tools:[{name:'a',inputSchema:{type:'object'}}],nextCursor:'next'};
 else {process.stderr.write('UNEXPECTED_TOOL_CALL'); process.exit(10);}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n');
}`;

test('opt-in smoke initializes and paginates tools without executing any tools', async t => {
  const f = await config(t, SERVER);
  const result = await doctor(f.config, { smoke: true, timeoutMs: 4000 });
  assert.equal(result.status, 'smoke_passed');
  assert.equal(result.executed.serverSmoke, true);
  assert.equal(result.checks.at(-1).toolCount, 2);
});

test('bounded smoke reports environment/timeout uncertainty without exposing stderr', async t => {
  const f = await config(t, 'process.stderr.write("private-server-secret"); setInterval(()=>{},1000);');
  const result = await doctor(f.config, { smoke: true, timeoutMs: 200 });
  assert.equal(result.status, 'not_ready');
  assert.match(result.checks.at(-1).detail, /Timed out/);
  assert.equal(JSON.stringify(result).includes('private-server-secret'), false);
});

test('bounded process stops a hung executable', async () => {
  const started = Date.now();
  const result = await runBounded(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 150 });
  assert.equal(result.reason, 'timeout');
  assert.ok(Date.now() - started < 6000);
});

test('prepare plan validates inputs and performs no writes or executable launches', async t => {
  const f = await fixture(t);
  const before = await readdir(f.base);
  const result = await prepareRuntime(f.path);
  assert.equal(result.status, 'planned');
  assert.equal(result.serverModule, 'demo');
  assert.deepEqual(await readdir(f.base), before);
  assert.equal(JSON.stringify(result).includes('not-for-report'), false);
  assert.equal(JSON.stringify(result).includes('/reviewed/config.yaml'), false);
});

test('manifest rejects existing destination and any source/destination overlap', async t => {
  const f = await fixture(t);
  f.manifest.runtimeDir = './package/runtime'; await f.save();
  await assert.rejects(planRuntime(f.path), /must not contain/);
  f.manifest.runtimeDir = './runtime'; await f.save(); await mkdir(join(f.base, 'runtime'));
  await assert.rejects(planRuntime(f.path), /already exists/);
});

test('manifest rejects duplicate names, range requirements, and direct URL lock entries', async t => {
  const f = await fixture(t);
  f.manifest.packages.push({ name: 'DEMO', path: './package' }); await f.save();
  await assert.rejects(planRuntime(f.path), /unique/);
  f.manifest.packages.pop(); f.manifest.requirements = ['fastmcp>=3']; await f.save();
  await assert.rejects(planRuntime(f.path), /exact/);
  f.manifest.requirements = []; f.manifest.lockFile = './lock.txt'; await writeFile(join(f.base, 'lock.txt'), 'pkg @ https://user:secret@example.test/pkg.whl\n'); await f.save();
  await assert.rejects(planRuntime(f.path), /exact package pins/);
});

test('manifest accepts exact external dependency lock and separately listed local sources', async t => {
  const f = await fixture(t);
  await mkdir(join(f.base, 'core'));
  await writeFile(join(f.base, 'core', 'setup.py'), 'pass\n');
  f.manifest.packages.push({ name: 'core', path: './core' });
  f.manifest.lockFile = './lock.txt'; await writeFile(join(f.base, 'lock.txt'), '# generated\nfastmcp==3.3.1\n\nPyYAML==6.0.3\n'); await f.save();
  const { plan } = await planRuntime(f.path);
  assert.equal(plan.packages.length, 2);
  assert.ok(plan.requirements.includes('fastmcp==3.3.1'));
  assert.ok(plan.requirements.includes('PyYAML==6.0.3'));
});

test('apply copies only source, uses isolated uv targets, records provenance and does not start server', async t => {
  const f = await fixture(t), calls = [];
  await mkdir(join(f.source, '.venv')); await writeFile(join(f.source, '.venv', 'old-python'), 'do not copy');
  await writeFile(join(f.source, '.env'), 'SECRET=hidden');
  await writeFile(join(f.source, '.envrc'), 'export SECRET=hidden');
  await writeFile(join(f.source, '.env.production'), 'SECRET=hidden');
  await writeFile(join(f.source, 'secret.pyc'), 'old cache');
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    return { code: 0, reason: null, stdout: args.includes('freeze') ? 'zeta==2.0\nalpha==1.0\n' : '', stderr: '' };
  };
  const result = await prepareRuntime(f.path, { apply: true, run });
  assert.equal(result.status, 'prepared'); assert.equal(result.serverLaunched, false);
  assert.equal(calls.length, 3);
  for (const call of calls) { assert.equal(call.command, process.execPath); assert.ok(call.args.includes('--cache-dir')); assert.equal(call.options.cwd, result.runtimeDir); }
  const copied = join(result.runtimeDir, 'source', 'demo');
  assert.deepEqual((await readdir(copied)).sort(), ['demo.py', 'pyproject.toml']);
  assert.equal(await readFile(join(f.source, '.env'), 'utf8'), 'SECRET=hidden');
  const generated = JSON.parse(await readFile(result.serverConfig, 'utf8'));
  assert.deepEqual(generated.args, ['-m', 'demo', '--config', '/reviewed/config.yaml']);
  assert.equal(generated.cwd, result.runtimeDir);
  const inventory = JSON.parse(await readFile(join(result.runtimeDir, 'source-hashes.json'), 'utf8'));
  assert.equal(inventory[0].files.length, 2); assert.match(inventory[0].files[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(await readFile(result.dependencyLock, 'utf8'), 'alpha==1.0\nzeta==2.0\n');
});

test('failed setup retains isolated state, classifies dependency issue, and does not expose raw output', async t => {
  const f = await fixture(t); let count = 0;
  const run = async () => ++count === 1 ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'No solution found; private-server-secret' };
  await assert.rejects(prepareRuntime(f.path, { apply: true, run }), error => /install_packages/.test(error.message) && !error.message.includes('private-server-secret'));
  const state = JSON.parse(await readFile(join(f.base, 'runtime', 'setup-status.json'), 'utf8'));
  assert.equal(state.status, 'failed'); assert.equal(state.stage, 'install_packages');
  assert.match(state.detail, /local package/); assert.equal(state.detail.includes('private-server-secret'), false);
  await assert.rejects(prepareRuntime(f.path, { apply: true, run }), /already exists/);
});

test('source symlinks or junctions fail before executing build commands', async t => {
  const f = await fixture(t); await mkdir(join(f.base, 'external'));
  try { await symlink(join(f.base, 'external'), join(f.source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('This environment cannot create symlinks.'); return; } throw error; }
  let invoked = false;
  await assert.rejects(prepareRuntime(f.path, { apply: true, run: async () => { invoked = true; return { code: 0 }; } }), /symbolic link or junction/);
  assert.equal(invoked, false);
  assert.equal((await stat(join(f.base, 'external'))).isDirectory(), true);
});
