import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { extractCatalog, validateCases, atPointer, evaluateCase } from '../scripts/check.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'scripts', 'check.mjs');
const makeCase = overrides => ({
  id: 'known-value', tool: 'probe', arguments: {},
  assertions: [{ path: '/structuredContent/value', op: 'type', value: 'string' }],
  comparePaths: ['/structuredContent/value'], ...overrides,
});
const success = (value, extra = {}) => ({
  status: 'success', result: { content: [], structuredContent: { value, ...extra } },
});

test('extractCatalog accepts direct and Inspector/JSON-RPC result envelopes', () => {
  const tools = [{ name: 'probe', inputSchema: { type: 'object' } }];
  assert.deepEqual(extractCatalog({ tools }), tools);
  assert.deepEqual(extractCatalog({ result: { tools } }), tools);
  assert.deepEqual(extractCatalog({ jsonrpc: '2.0', id: 7, result: { tools } }), tools);
  assert.deepEqual(extractCatalog({ tools: [] }), []);
});

test('extractCatalog refuses incomplete pages, error envelopes, and malformed shapes', () => {
  for (const input of [
    null, [], {}, { tools: {} }, { result: { tools: null } },
    { tools: [], nextCursor: 'page-2' },
    { result: { tools: [], nextCursor: 'page-2' } },
    { result: { tools: [], nextCursor: null } },
    { error: { code: -1 }, result: { tools: [] } },
  ]) assert.throws(() => extractCatalog(input));
});

test('validateCases accepts explicit assertions and stable paths', () => {
  const c = makeCase({ assertions: [
    { path: '/structuredContent/value', op: 'equals', value: null },
    { path: '/content', op: 'exists' },
    { path: '/content', op: 'type', value: 'array' },
  ] });
  assert.deepEqual(validateCases({ cases: [c] }), [c]);
  assert.equal(validateCases({ cases: [makeCase({ assertions: undefined })] }).length, 1);
});

test('validateCases rejects malformed and ambiguous requests before execution', () => {
  const invalid = [
    null, {}, { cases: [] }, { cases: [makeCase()], unexpected: true },
    { cases: [makeCase(), makeCase()] },
    { cases: [makeCase({ id: '' })] },
    { cases: [makeCase({ tool: '' })] },
    { cases: [makeCase({ arguments: null })] },
    { cases: [makeCase({ arguments: [] })] },
    { cases: [makeCase({ unexpected: true })] },
    { cases: [makeCase({ assertions: {}, comparePaths: [] })] },
    { cases: [makeCase({ assertions: [], comparePaths: [] })] },
    { cases: [makeCase({ comparePaths: ['/bad~escape'] })] },
    { cases: [makeCase({ comparePaths: ['not/a/pointer'] })] },
    { cases: [makeCase({ assertions: [{ path: '/x', op: 'unknown' }] })] },
    { cases: [makeCase({ assertions: [{ path: '/x', op: 'equals' }] })] },
    { cases: [makeCase({ assertions: [{ path: '/x', op: 'exists', value: true }] })] },
    { cases: [makeCase({ assertions: [{ path: '/x', op: 'type', value: 'date' }] })] },
    { cases: [makeCase({ assertions: [{ path: '/x', op: 'exists', optional: true }] })] },
  ];
  for (const input of invalid) assert.throws(() => validateCases(input));
});

test('JSON Pointers preserve escaped names and distinguish missing values from null', () => {
  const input = { 'a/b': { '~key': null }, rows: [{ value: 0 }], '': false };
  assert.deepEqual(atPointer(input, '/a~1b/~0key'), { exists: true, value: null });
  assert.deepEqual(atPointer(input, '/rows/0/value'), { exists: true, value: 0 });
  assert.deepEqual(atPointer(input, '/'), { exists: true, value: false });
  assert.deepEqual(atPointer(input, ''), { exists: true, value: input });
  for (const pointer of ['/a~1b/~0key/child', '/missing', '/rows/1', '/rows/00', '/rows/length', '/toString']) {
    assert.deepEqual(atPointer(input, pointer), { exists: false });
  }
  assert.throws(() => atPointer(input, '/bad~2'));
  assert.throws(() => atPointer(input, '/bad~'));
});

test('invalid baseline assertions or missing selected paths make a case inconclusive', () => {
  const c = makeCase({ assertions: [{ path: '/structuredContent/value', op: 'equals', value: 'expected' }] });
  assert.equal(evaluateCase(c, success('wrong'), success('expected')).status, 'inconclusive');
  assert.equal(evaluateCase(c, success('wrong'), { status: 'tool_error' }).status, 'inconclusive');
  assert.equal(evaluateCase(makeCase(), { status: 'tool_error' }, success('ok')).status, 'inconclusive');
  const missing = evaluateCase(makeCase({ assertions: [] }), { status: 'success', result: { content: [] } }, success('ok'));
  assert.equal(missing.status, 'inconclusive');
  assert.equal(missing.failures[0].reason, 'baseline_path_missing');
});

test('candidate tool/protocol errors and missing tools regress only a valid baseline', () => {
  for (const status of ['tool_error', 'protocol_error', 'missing_tool']) {
    assert.equal(evaluateCase(makeCase(), success('ok'), { status }).status, 'regression');
  }
  for (const status of ['transport_error', 'not_run']) {
    assert.equal(evaluateCase(makeCase(), success('ok'), { status }).status, 'inconclusive');
  }
});

test('evaluation compares only selected paths and never includes raw argument or result values', () => {
  const c = makeCase({ arguments: { secret: 'PRIVATE-ARGUMENT' } });
  assert.equal(evaluateCase(c, success('stable', { timestamp: 'old', secret: 'PRIVATE-OLD' }),
    success('stable', { timestamp: 'new', secret: 'PRIVATE-NEW' })).status, 'pass');
  const changed = evaluateCase(c, success('PRIVATE-OLD'), success('PRIVATE-NEW'));
  assert.equal(changed.status, 'regression');
  assert.deepEqual(changed.failures, [{ path: '/structuredContent/value', check: 'compare', reason: 'selected_value_changed' }]);
  assert.doesNotMatch(JSON.stringify(changed), /PRIVATE-/);
  const missing = evaluateCase(c, success('ok'), { status: 'success', result: { content: [] } });
  assert.equal(missing.status, 'regression');
  assert.ok(missing.failures.some(f => f.reason === 'path_missing'));
});

test('exists, null, integer, and structural equality assertions have distinct behavior', () => {
  const c = makeCase({ comparePaths: [], assertions: [
    { path: '/structuredContent/value', op: 'exists' },
    { path: '/structuredContent/value', op: 'type', value: 'null' },
    { path: '/structuredContent/count', op: 'type', value: 'integer' },
    { path: '/structuredContent/object', op: 'equals', value: { a: 1, b: [2] } },
  ] });
  const before = success(null, { count: 2, object: { b: [2], a: 1 } });
  assert.equal(evaluateCase(c, before, success(null, { count: 3, object: { a: 1, b: [2] } })).status, 'pass');
  assert.equal(evaluateCase(c, before, success(null, { count: 3.5, object: { a: 1, b: [2] } })).status, 'regression');
});

const fakeServer = String.raw`
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [mode, trace, label] = process.argv.slice(2);
const log = entry => appendFileSync(trace, JSON.stringify({ label, ...entry }) + '\n');
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
log({ event: 'start', pid: process.pid });
let initialized = false;
let pages = 0;
const probe = { name: 'probe', inputSchema: { type: 'object' }, outputSchema: {
  type: 'object', properties: { value: { type: 'string' } }, required: ['value']
} };
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  log({ event: m.method, ...(m.params?.cursor ? { cursor: m.params.cursor } : {}) });
  if (m.method === 'initialize') {
    send(m.id, { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } });
  } else if (m.method === 'notifications/initialized') {
    initialized = true;
  } else if (m.method === 'tools/list') {
    if (!initialized) process.exit(90);
    pages++;
    if (pages === 1 && m.params?.cursor === undefined) {
      send(m.id, { tools: [{ name: 'other', inputSchema: { type: 'object' } }], nextCursor: 'page-2' });
    } else if (pages === 2 && m.params?.cursor === 'page-2') {
      send(m.id, { tools: mode === 'malformed' ? [{ name: 'probe', inputSchema: { type: 'not-a-schema-type' } }] : [probe] });
    } else process.exit(91);
  } else if (m.method === 'tools/call') {
    if (!initialized || pages !== 2 || m.params?.name !== 'probe') process.exit(92);
    if (mode === 'hang') return;
    const value = mode === 'changed' ? 'PRIVATE-CANDIDATE-RESULT' : 'PRIVATE-BASELINE-RESULT';
    send(m.id, { content: [{ type: 'text', text: 'PRIVATE-UNSELECTED-' + label }], structuredContent: { value, timestamp: label } });
  }
});
`;

async function traceRows(path) {
  try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function fixture(t, beforeMode = 'stable', afterMode = 'stable', cases) {
  const tempRoot = resolve(tmpdir());
  const dir = await mkdtemp(join(tempRoot, 'mcp-upgrade-runner-'));
  const script = join(dir, 'fake-server.mjs');
  const trace = join(dir, 'trace.jsonl');
  t.after(async () => {
    for (const { pid } of (await traceRows(trace)).filter(row => row.event === 'start')) {
      try { if (alive(pid)) process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    const subpath = relative(tempRoot, resolve(dir));
    assert.ok(subpath.startsWith('mcp-upgrade-runner-') && !subpath.startsWith('..') && !isAbsolute(subpath), 'cleanup stays inside its created temp directory');
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await writeFile(script, fakeServer);
  for (const [label, mode] of [['before', beforeMode], ['after', afterMode]]) {
    await writeFile(join(dir, `${label}.json`), JSON.stringify({ command: process.execPath, args: [script, mode, trace, label], cwd: '.' }));
  }
  await writeFile(join(dir, 'cases.json'), JSON.stringify({ cases: cases ?? [makeCase({ arguments: { secret: 'PRIVATE-ARGUMENT' } })] }));
  const output = join(dir, 'report.json');
  const args = ['replay', '--before-config', join(dir, 'before.json'), '--after-config', join(dir, 'after.json'),
    '--cases', join(dir, 'cases.json'), '--out', output];
  return { dir, trace, output, args };
}

function runCLI(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Test CLI did not finish within 15 seconds.')); }, 15000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolveRun({ code, signal, stdout, stderr }); });
  });
}

test('CLI execution gate refuses replay before launching either executable', async t => {
  const f = await fixture(t);
  const result = await runCLI(f.args);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /execute-cases/);
  assert.deepEqual(await traceRows(f.trace), []);
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});

test('CLI fully initializes and paginates before one call per version; unchanged selected values pass', async t => {
  const f = await fixture(t);
  const result = await runCLI([...f.args, '--execute-cases']);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(report.verdict, 'no_detected_issues_in_checked_scope');
  assert.deepEqual(report.toolCounts, { before: 2, after: 2 });
  assert.equal(report.cases[0].status, 'pass');
  const rows = await traceRows(f.trace);
  for (const label of ['before', 'after']) {
    const events = rows.filter(row => row.label === label);
    assert.deepEqual(events.map(row => row.event), ['start', 'initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'tools/call']);
    assert.equal(events[4].cursor, 'page-2');
  }
  const markdown = await readFile(join(f.dir, 'report.md'), 'utf8');
  assert.doesNotMatch(JSON.stringify(report) + markdown + result.stdout + result.stderr, /PRIVATE-/);
});

test('CLI detects changed selected behavior even when both tool catalogs are identical', async t => {
  const f = await fixture(t, 'stable', 'changed');
  const result = await runCLI([...f.args, '--execute-cases']);
  assert.equal(result.code, 1, result.stderr);
  const reportText = await readFile(f.output, 'utf8');
  const report = JSON.parse(reportText);
  assert.equal(report.verdict, 'regression_detected');
  assert.deepEqual(report.findings, []);
  assert.equal(report.cases[0].status, 'regression');
  assert.ok(report.cases[0].failures.some(failure => failure.reason === 'selected_value_changed'));
  assert.doesNotMatch(reportText + await readFile(join(f.dir, 'report.md'), 'utf8'), /PRIVATE-/);
});

test('CLI timeout is inconclusive, prevents subsequent calls, and terminates both launched servers', async t => {
  const cases = [makeCase(), makeCase({ id: 'second-case' })];
  const f = await fixture(t, 'stable', 'hang', cases);
  // Allow process startup under Windows/parallel test load; the candidate
  // intentionally never answers its tool call, so timeout behavior is unchanged.
  const result = await runCLI([...f.args, '--execute-cases', '--timeout-ms', '3000']);
  assert.equal(result.code, 3, result.stderr);
  const report = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(report.verdict, 'review_required');
  assert.deepEqual(report.cases.map(c => c.status), ['inconclusive', 'inconclusive']);
  assert.deepEqual(report.cases.map(c => c.after), ['transport_error', 'not_run']);
  const rows = await traceRows(f.trace);
  assert.equal(rows.filter(row => row.label === 'after' && row.event === 'tools/call').length, 1);
  const pids = rows.filter(row => row.event === 'start').map(row => row.pid);
  assert.equal(pids.length, 2);
  for (let attempt = 0; attempt < 40 && pids.some(alive); attempt++) await delay(50);
  assert.ok(pids.every(pid => !alive(pid)), 'no launched server survives a timed-out replay');
});

test('CLI rejects a malformed paginated catalog before calling any tools', async t => {
  const f = await fixture(t, 'malformed', 'stable');
  const result = await runCLI([...f.args, '--execute-cases']);
  assert.equal(result.code, 2);
  const rows = await traceRows(f.trace);
  assert.equal(rows.filter(row => row.event === 'tools/list').length, 2);
  assert.equal(rows.filter(row => row.event === 'tools/call').length, 0);
  assert.equal(rows.filter(row => row.label === 'after').length, 0);
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});
