import test from 'node:test';
import assert from 'node:assert/strict';
import { measureCatalogPayloads } from '../scripts/metrics.mjs';

const tool = (name, description = '') => ({ name, description, inputSchema: { type: 'object' } });
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

test('catalog metrics measure exact compact UTF-8 JSON including Unicode and metadata', () => {
  const before = [tool('lookup', 'é')];
  const after = [{ ...tool('lookup', 'é🔎'), _meta: { fixture: true } }, tool('added')];
  const result = measureCatalogPayloads(before, after).catalogPayload;
  assert.equal(result.beforeBytes, bytes(before));
  assert.equal(result.afterBytes, bytes(after));
  assert.equal(result.deltaBytes, bytes(after) - bytes(before));
  assert.equal(result.largestIncreases.find(item => item.tool === 'lookup').deltaBytes,
    bytes(after[0]) - bytes(before[0]));
  assert.match(result.interpretation, /not tokens, latency, or task efficiency/);
});

test('equivalent object ordering does not change measured size and inputs are unmodified', () => {
  const before = [tool('lookup')];
  const after = [{ inputSchema: { type: 'object' }, description: '', name: 'lookup' }];
  const original = structuredClone({ before, after });
  assert.equal(measureCatalogPayloads(before, after).catalogPayload.deltaBytes, 0);
  assert.deepEqual({ before, after }, original);
});

test('empty and smaller catalogs report bytes without fabricating efficiency percentages', () => {
  const empty = measureCatalogPayloads([], [tool('new')]).catalogPayload;
  assert.equal(empty.beforeBytes, 2);
  assert.equal(empty.deltaPercent, null);
  const smaller = measureCatalogPayloads([tool('removed')], []).catalogPayload;
  assert.ok(smaller.deltaBytes < 0);
  assert.deepEqual(smaller.largestIncreases, []);
});

test('size contributors are bounded, deterministic, and omit raw tool content', () => {
  const after = Array.from({ length: 9 }, (_, i) => tool(`tool_${i}`, 'PRIVATE-CONTENT'));
  const result = measureCatalogPayloads([], after).catalogPayload;
  assert.equal(result.largestIncreases.length, 5);
  assert.deepEqual(result.largestIncreases.map(item => item.tool), ['tool_0', 'tool_1', 'tool_2', 'tool_3', 'tool_4']);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-CONTENT/);
  assert.throws(() => measureCatalogPayloads([tool('duplicate'), tool('duplicate')], []), /uniquely named/);
});
