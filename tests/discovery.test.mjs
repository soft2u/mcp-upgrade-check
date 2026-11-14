import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDiscoveryManifest, discoverActions, normalizeDiscovery, compareDiscovered } from '../scripts/discovery.mjs';

const source = overrides => ({
  id: 'component', discoveryTool: 'search_actions', executionTool: 'execute_action', arguments: { limit: 100 },
  actionsPath: '/structuredContent/result/actions', successPath: '/structuredContent/success',
  fields: { name: 'name', description: 'description', inputSchema: 'input_schema', outputSchema: 'output_schema' },
  completeness: { mode: 'limit', allActionsRequested: true, limit: 100 }, ...overrides,
});
const manifest = overrides => ({ sources: [source(overrides)] });
const action = (name = 'lookup', rest = {}) => ({ name, input_schema: { type: 'object' }, ...rest });
const toolResult = (actions, metadata = {}) => ({ content: [], structuredContent: { success: true, result: { actions, ...metadata } } });
const capture = (actions, metadata) => ({ search_actions: { jsonrpc: '2.0', id: 1, result: toolResult(actions, metadata) } });
const normalized = (actions, overrides, metadata) => normalizeDiscovery(capture(actions, metadata), manifest(overrides));
const compare = (beforeActions, afterActions, overrides, beforeMeta, afterMeta) => compareDiscovered(
  normalized(beforeActions, overrides, beforeMeta), normalized(afterActions, overrides, afterMeta));

test('manifest validates explicit adapters and defaults to unknown coverage', () => {
  const s = source(); delete s.completeness;
  assert.deepEqual(validateDiscoveryManifest({ sources: [s] }).sources[0].completeness, { mode: 'unknown', allActionsRequested: false });
  for (const bad of [
    {}, { sources: [] }, { sources: [source(), source()] }, manifest({ id: '' }),
    manifest({ fields: { name: '/name' } }), manifest({ arguments: [] }),
    manifest({ actionsPath: '/invalid~2' }), manifest({ actionsPath: 'not-a-pointer' }),
    manifest({ completeness: { mode: 'limit', allActionsRequested: true, limit: 0 } }),
    manifest({ completeness: { mode: 'guess' } }), manifest({ extra: true }),
    manifest({ successPath: undefined }),
  ]) assert.throws(() => validateDiscoveryManifest(bad));
});

test('normalization accepts legacy tool-keyed JSON-RPC and source-keyed live captures', () => {
  const old = normalized([action()]);
  const live = normalizeDiscovery({ component: { status: 'success', result: toolResult([action()]), executionToolAvailable: true } }, manifest());
  const raw = normalizeDiscovery({ component: toolResult([action()]) }, manifest());
  assert.deepEqual(live, old);
  assert.deepEqual(raw, old);
  assert.equal(old.sources[0].coverage.status, 'complete');
  assert.equal(old.actions[0].id, 'component::execute_action::lookup');
});

test('adapter pointers can read escaped keys without inspecting arbitrary response fields', () => {
  const m = manifest({ actionsPath: '/structuredContent/a~1b/~0actions', successPath: '/structuredContent/ok' });
  const n = normalizeDiscovery({ component: { content: [], structuredContent: { ok: true, 'a/b': { '~actions': [action()] } } } }, m);
  assert.equal(n.actions.length, 1);
});

test('qualified identities distinguish same-named actions in different components and parents', () => {
  const m = { sources: [source({ id: 'first', discoveryTool: 'first_search', executionTool: 'first_execute' }),
    source({ id: 'second', discoveryTool: 'second_search', executionTool: 'second_execute' })] };
  const n = normalizeDiscovery({ first: toolResult([action('status')]), second: toolResult([action('status')]) }, m);
  assert.equal(new Set(n.actions.map(a => a.id)).size, 2);
  assert.equal(n.actions[1].id, 'second::second_execute::status');
  const encoded = normalized([action('a::b/c')]);
  assert.equal(encoded.actions[0].id, 'component::execute_action::a%3A%3Ab%2Fc');
});

test('malformed or duplicate action contracts are rejected instead of silently overwritten', () => {
  for (const actions of [[action(), action()], [null], [{ name: '' }], [action('x', { input_schema: null })],
    [action('x', { input_schema: { type: 'invalid' } })], [action('x', { output_schema: [] })], [action('x', { description: 7 })]]) {
    assert.throws(() => normalized(actions));
  }
  assert.throws(() => normalizeDiscovery({ component: toolResult({ wrong: 'shape' }) }, manifest()));
  assert.throws(() => normalizeDiscovery({ component: { jsonrpc: '2.0', result: {}, error: {} } }, manifest()));
  const m = { sources: [source({ id: 'a' }), source({ id: 'b' })] };
  assert.throws(() => normalizeDiscovery(capture([action()]), m), /source id/);
});

test('missing schema metadata preserves action identity and never fabricates an empty schema', () => {
  const before = normalized([action()]);
  const after = normalized([{ name: 'lookup' }]);
  assert.equal(Object.hasOwn(after.actions[0], 'inputSchema'), false);
  const result = compareDiscovered(before, after);
  assert.equal(result.inventory[0].after.present, true);
  assert.equal(result.inventory[0].after.inputSchema, 'missing');
  assert.ok(result.findings.some(f => f.code === 'discovered_input_schema_missing' && f.severity === 'review'));
  assert.equal(result.findings.some(f => f.code === 'discovered_action_removed'), false);
});

test('complete candidate inventory establishes a static removal risk', () => {
  const result = compare([action('removed'), action('kept')], [action('kept')]);
  assert.ok(result.findings.some(f => f.code === 'discovered_action_removed' && f.severity === 'breaking' && f.tool.endsWith('::removed')));
  const empty = compare([action()], []);
  assert.ok(empty.findings.some(f => f.code === 'discovered_action_removed'));
});

test('limit saturation never turns unseen actions into confirmed removals', () => {
  const m = { completeness: { mode: 'limit', allActionsRequested: true, limit: 1 } };
  const result = compare([action('old')], [action('new')], m);
  assert.equal(result.coverage[0].after.status, 'partial');
  assert.ok(result.coverage[0].after.reasons.includes('limit_reached'));
  assert.equal(result.findings.some(f => f.code === 'discovered_action_removed'), false);
  assert.ok(result.findings.some(f => f.code === 'discovered_action_not_observed'));
  assert.ok(result.findings.some(f => f.code === 'discovered_action_newly_observed'));
});

test('remaining cursors, totals and truncation flags independently prevent false removals', () => {
  for (const [signal, metadata, reason] of [
    [{ nextCursorPath: '/structuredContent/result/cursor' }, { cursor: 'page-2' }, 'remaining_cursor'],
    [{ totalPath: '/structuredContent/result/total' }, { total: 9 }, 'reported_total_exceeds_count'],
    [{ totalPath: '/structuredContent/result/total' }, {}, 'reported_total_missing'],
    [{ truncatedPath: '/structuredContent/result/truncated' }, { truncated: true }, 'reported_truncated'],
    [{ truncatedPath: '/structuredContent/result/truncated' }, {}, 'truncation_flag_missing'],
  ]) {
    const m = { completeness: { mode: 'unpaginated', allActionsRequested: true, ...signal } };
    const result = compare([action('old')], [action('new')], m, metadata, metadata);
    assert.equal(result.coverage[0].after.status, 'partial');
    assert.ok(result.coverage[0].after.reasons.includes(reason));
    assert.equal(result.findings.some(f => f.code === 'discovered_action_removed'), false);
  }
});

test('explicit total can prove completion at the limit, but cannot override a remaining cursor', () => {
  const completeness = { mode: 'limit', allActionsRequested: true, limit: 1,
    totalPath: '/structuredContent/result/total', nextCursorPath: '/structuredContent/result/cursor' };
  assert.equal(normalized([action()], { completeness }, { total: 1 }).sources[0].coverage.status, 'complete');
  assert.equal(normalized([action()], { completeness }, { total: 1, cursor: 'next' }).sources[0].coverage.status, 'partial');
});

test('filtered or unknown discovery cannot claim removals, even with an empty result', () => {
  for (const completeness of [{ mode: 'unpaginated', allActionsRequested: false }, { mode: 'unknown', allActionsRequested: true }]) {
    const result = compare([action()], [], { completeness });
    assert.equal(result.findings.some(f => f.code === 'discovered_action_removed'), false);
    assert.equal(result.coverage[0].after.status, 'partial');
  }
});

test('application errors, transport errors, and absent captures yield unavailable coverage', () => {
  const before = normalized([action()]);
  for (const capture of [
    {}, { component: { status: 'transport_error' } },
    { component: { jsonrpc: '2.0', id: 1, error: { code: -1, message: 'PRIVATE-ERROR' } } },
    { component: { content: [], isError: true, structuredContent: { success: true, result: { actions: [] } } } },
    { component: { content: [], structuredContent: { success: false, error: 'PRIVATE-ERROR' } } },
  ]) {
    const after = normalizeDiscovery(capture, manifest());
    assert.equal(after.sources[0].coverage.status, 'unavailable');
    const result = compareDiscovered(before, after);
    assert.equal(result.findings.some(f => f.code === 'discovered_action_removed'), false);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-ERROR/);
  }
});

test('known output schemas are compared even when input schemas are absent', () => {
  const before = [{ name: 'lookup', output_schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }];
  const after = [{ name: 'lookup', output_schema: { type: 'object', properties: { value: { type: ['string', 'null'] } }, required: ['value'] } }];
  const result = compare(before, after);
  assert.ok(result.findings.some(f => f.severity === 'breaking' && f.path.includes('/outputSchema/')));
  assert.ok(result.findings.some(f => f.code === 'discovered_input_schema_missing'));
  assert.equal(result.counts.beforeWithInputSchema, 0);
  assert.equal(result.counts.beforeWithOutputSchema, 1);
});

test('nested input contracts preserve schema narrowing and metadata finding paths', () => {
  const result = compare([action('lookup', { description: 'old', input_schema: { type: 'object', properties: { id: { type: 'string' } } } })],
    [action('lookup', { description: 'new', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } })]);
  assert.ok(result.findings.some(f => f.severity === 'breaking' && f.path.startsWith('/tools/component::execute_action::lookup/inputSchema')));
  assert.ok(result.findings.some(f => f.code === 'tool_metadata_changed' && f.path.endsWith('/description')));
});

test('report inventory omits schema bodies, descriptions, arguments, and raw response fields', () => {
  const a = action('lookup', { description: 'PRIVATE-DESCRIPTION', input_schema: { type: 'object', examples: ['PRIVATE-SCHEMA'] } });
  const result = compare([a], [a]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-/);
  assert.equal(result.inventory[0].before.inputSchema, 'present');
  assert.equal(result.inventory[0].before.outputSchema, 'missing');
});

test('live discovery calls only configured discovery tools and propagates detail arguments', async () => {
  const calls = [];
  const m = manifest({ arguments: { limit: 100, detailed: true } });
  const client = { async request(method, params) { calls.push({ method, params }); return { jsonrpc: '2.0', id: 1, result: toolResult([action()]) }; } };
  const data = await discoverActions(client, [{ name: 'search_actions' }, { name: 'execute_action' }], m);
  assert.deepEqual(calls, [{ method: 'tools/call', params: { name: 'search_actions', arguments: { limit: 100, detailed: true } } }]);
  assert.equal(normalizeDiscovery(data, m).sources[0].coverage.status, 'complete');
});

test('missing live discovery tool never calls anything and missing execution tool prevents complete coverage', async () => {
  let count = 0;
  const client = { async request() { count++; return { result: toolResult([action()]) }; } };
  const missing = await discoverActions(client, [{ name: 'execute_action' }], manifest());
  assert.equal(count, 0);
  assert.equal(normalizeDiscovery(missing, manifest()).sources[0].coverage.status, 'unavailable');
  const noExecution = await discoverActions(client, [{ name: 'search_actions' }], manifest());
  const n = normalizeDiscovery(noExecution, manifest());
  assert.equal(count, 1);
  assert.equal(n.actions.length, 1);
  assert.equal(n.sources[0].coverage.status, 'partial');
  assert.ok(n.sources[0].coverage.reasons.includes('execution_tool_missing'));
});

test('live transport failure is not retried and a fatal session skips subsequent sources', async () => {
  let calls = 0;
  const client = { fatal: null, async request() { calls++; this.fatal = new Error('PRIVATE-FAILURE'); throw this.fatal; } };
  const m = { sources: [source(), source({ id: 'second' })] };
  const data = await discoverActions(client, [{ name: 'search_actions' }, { name: 'execute_action' }], m);
  assert.equal(calls, 1);
  assert.equal(data.component.status, 'transport_error');
  assert.equal(data.second.status, 'not_run');
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE-/);
});
