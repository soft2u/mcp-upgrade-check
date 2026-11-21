import test from 'node:test';
import assert from 'node:assert/strict';
import { compareCatalogs } from '../scripts/schema-diff.mjs';
import { renderMarkdown, summarizeFindings } from '../scripts/report.mjs';
import { measureCatalogPayloads } from '../scripts/metrics.mjs';

const finding = (code, path, severity = 'review', message = code, tool = 'lookup') => ({ code, path, severity, message, tool });
const metadata = (kind, tool = 'lookup') => finding('tool_metadata_changed', `/tools/${tool}/${kind}`, 'review', `${kind} was edited`, tool);
const report = (findings = [], cases = [], extra = {}) => ({
  mode: 'compare', verdict: 'review_required', toolCounts: { before: 1, after: 1 },
  sources: { before: 'old.json', after: 'new.json' }, findings, cases,
  limitations: ['Only the supplied fixtures are covered.'], ...extra,
});

test('title/description changes are counted without mutating or reclassifying findings', () => {
  const findings = [metadata('title'), metadata('description'), finding('type_changed', '/tools/lookup/inputSchema/type', 'breaking')];
  for (const item of findings) Object.freeze(item);
  Object.freeze(findings);
  const summary = summarizeFindings(findings);
  assert.equal(summary.total, 3);
  assert.deepEqual(summary.severityCounts, { breaking: 1, review: 2, info: 0, other: 0 });
  assert.deepEqual(summary.detailedFindings, [findings[2]]);
  assert.equal(summary.detailedFindings[0], findings[2]);
  assert.deepEqual(summary.textOnlyMetadata, {
    count: 2, titleCount: 1, descriptionCount: 1, tools: ['lookup'],
    severityCounts: { breaking: 0, review: 2, info: 0, other: 0 },
  });
});

test('real comparator risks, default edits and unsupported keywords remain detailed', () => {
  const before = [{ name: 'lookup', title: 'Old title', inputSchema: {
    type: 'object', properties: { id: { type: 'string', description: 'Old description', default: 'a', enum: ['a', 'b'] } },
    allOf: [{ minProperties: 0 }],
  } }];
  const after = structuredClone(before);
  after[0].title = 'New title';
  after[0].inputSchema.properties.id.description = 'New description';
  after[0].inputSchema.properties.id.default = 'b';
  after[0].inputSchema.properties.id.enum = ['b'];
  after[0].inputSchema.required = ['id'];
  after[0].inputSchema.allOf = [{ minProperties: 1 }];
  const findings = compareCatalogs(before, after);
  const summary = summarizeFindings(findings);
  assert.equal(summary.textOnlyMetadata.count, 2);
  for (const code of ['allowed_values_changed', 'required_added', 'unsupported_keyword_changed']) {
    assert.ok(summary.detailedFindings.some(item => item.code === code), code);
  }
  assert.ok(summary.detailedFindings.some(item => item.path.endsWith('/default')));
  const markdown = renderMarkdown(report(findings));
  assert.match(markdown, /default/);
  assert.match(markdown, /required/);
  assert.match(markdown, /unsupported\\_keyword\\_changed/);
});

test('a title/description suffix alone cannot hide constraints or uncertainty', () => {
  const findings = [
    finding('unsupported_keyword_changed', '/tools/lookup/inputSchema/$defs/description'),
    finding('required_added', '/tools/lookup/inputSchema/properties/description'),
    finding('tool_metadata_changed', '/tools/lookup/default/description'),
    finding('schema_annotation_changed', '/tools/lookup/inputSchema/default/description'),
    finding('schema_annotation_changed', '/tools/lookup/inputSchema/properties/description'),
    finding('catalog_changed_during_replay', '/tools/lookup/description'),
    metadata('title', 'lookup~0unexpected'), // tool does not match decoded pointer name
  ];
  const summary = summarizeFindings(findings);
  assert.equal(summary.textOnlyMetadata.count, 0);
  assert.equal(summary.detailedFindings.length, findings.length);
});

test('breaking and unknown-severity metadata remain prominent', () => {
  const findings = [{ ...metadata('description'), severity: 'breaking' }, { ...metadata('title'), severity: 'custom' }];
  const summary = summarizeFindings(findings);
  assert.equal(summary.textOnlyMetadata.count, 0);
  assert.deepEqual(summary.severityCounts, { breaking: 1, review: 0, info: 0, other: 1 });
});

test('nested title/description annotations can be summarized at valid schema locations', () => {
  const findings = [
    finding('schema_annotation_changed', '/tools/lookup/inputSchema/properties/description/description'),
    finding('schema_annotation_changed', '/tools/lookup/outputSchema/items/properties/id/title'),
    finding('schema_annotation_changed', '/tools/lookup/inputSchema/anyOf/0/description'),
    finding('schema_annotation_changed', '/tools/lookup/inputSchema/enum/0/description'),
  ];
  const summary = summarizeFindings(findings);
  assert.equal(summary.textOnlyMetadata.count, 3);
  assert.deepEqual(summary.detailedFindings, [findings[3]]);
});

test('grouped metadata retains review verdict and reports no behavioral certification', () => {
  const data = report([metadata('title'), metadata('description')]);
  const original = structuredClone(data);
  const markdown = renderMarkdown(data);
  assert.match(markdown, /Verdict: \*\*review\\_required\*\*/);
  assert.match(markdown, /2 findings summarized/);
  assert.match(markdown, /does not establish compatibility or change the verdict/);
  assert.match(markdown, /Behavioral replay was not performed/);
  assert.doesNotMatch(markdown, /title was edited|description was edited/);
  assert.deepEqual(data, original);
});

test('successful replay cases are compact but failures and inconclusive evidence stay detailed', () => {
  const cases = [
    { id: 'working-a', tool: 'lookup', status: 'pass', before: 'success', after: 'success', failures: [] },
    { id: 'working-b', tool: 'lookup', status: 'pass', before: 'success', after: 'success', failures: [] },
    { id: 'broken', tool: 'lookup', status: 'regression', before: 'success', after: 'success', reason: 'Stable field changed.', failures: [{ path: '/structuredContent/id', check: 'compare', reason: 'selected_value_changed' }] },
    { id: 'uncertain', tool: 'lookup', status: 'inconclusive', before: 'transport_error', after: 'success', reason: 'Baseline unavailable.', failures: [] },
  ];
  const markdown = renderMarkdown(report([], cases, { verdict: 'regression_detected', mode: 'replay' }));
  assert.match(markdown, /2 passed, 1 regressions, 1 inconclusive/);
  assert.match(markdown, /Passed case IDs: working-a, working-b/);
  assert.doesNotMatch(markdown, /\*\*pass\*\* working-a/);
  assert.match(markdown, /\*\*regression\*\* broken/);
  assert.match(markdown, /structuredContent\/id/);
  assert.match(markdown, /selected\\_value\\_changed/);
  assert.match(markdown, /Baseline unavailable/);
});

test('a pass with additional findings or an explicit note is not silently collapsed', () => {
  const cases = [{ id: 'annotated', tool: 'lookup', status: 'pass', before: 'success', after: 'success', reason: 'Manual condition remains.', failures: [{ path: '/id', check: 'review', reason: 'manual' }] }];
  const markdown = renderMarkdown(report([], cases));
  assert.match(markdown, /Manual condition remains/);
  assert.match(markdown, /review \/ manual/);
});

test('action-only coverage exposes partial discovery and missing schemas separately from tools', () => {
  const discovery = {
    counts: { before: 2, after: 3, beforeWithInputSchema: 1, afterWithInputSchema: 2 },
    coverage: [{ sourceId: 'component', discoveryTool: 'search', executionTool: 'execute',
      before: { status: 'complete', actionCount: 2, reasons: ['fewer_than_declared_limit'] },
      after: { status: 'partial', actionCount: 3, reasons: ['limit_reached'] } }],
    inventory: [
      { sourceId: 'component', executionTool: 'execute', name: 'a', before: { present: true, inputSchema: 'present' }, after: { present: true, inputSchema: 'present' } },
      { sourceId: 'component', executionTool: 'execute', name: 'b', before: { present: true, inputSchema: 'missing' }, after: { present: true, inputSchema: 'missing' } },
      { sourceId: 'component', executionTool: 'execute', name: 'c', before: { present: false, inputSchema: 'absent' }, after: { present: true, inputSchema: 'present' } },
    ],
  };
  const markdown = renderMarkdown(report([], [], { mode: 'compare-actions', toolCounts: { before: 0, after: 0 }, discovery }));
  assert.match(markdown, /action-only comparison\. MCP tool catalogs were not compared/);
  assert.match(markdown, /Missing input schemas: \*\*1 before, 1 after/);
  assert.match(markdown, /\| component \/ execute \| 2 actions; complete \| 3 actions; partial \| 1\/2 → 2\/3 \|/);
  assert.match(markdown, /limit\\_reached/);
  assert.doesNotMatch(markdown, /Tools: 0 before/);
});

test('unavailable discovery and absent completion evidence remain visible', () => {
  const markdown = renderMarkdown(report([], [], { discovery: {
    counts: { before: 0, after: 0, beforeWithInputSchema: 0, afterWithInputSchema: 0 },
    coverage: [{ sourceId: 'offline', executionTool: 'execute', before: { status: 'unavailable', actionCount: 0, reasons: ['connection_failed'] }, after: { status: 'complete', actionCount: 0, reasons: [] } }], inventory: [],
  } }));
  assert.match(markdown, /unavailable/);
  assert.match(markdown, /connection\\_failed/);
  assert.match(renderMarkdown(report([], [], { discovery: { counts: { before: 1, after: 1 } } })), /counts alone do not establish complete discovery/);
});

test('untrusted server text cannot inject Markdown links or HTML into the report', () => {
  const data = report([finding('custom', '/tools/lookup/type', 'review', '<script>alert(1)</script>\n![image](https://example.test)')]);
  const markdown = renderMarkdown(data);
  assert.doesNotMatch(markdown, /<script>|!\[image\]/);
  assert.match(markdown, /\\<script\\>/);
  assert.match(markdown, /Only the supplied fixtures are covered/);
});

test('reports show candidate checks even when the baseline invalidates upgrade attribution', () => {
  const cases = [{ id: 'disabled-policy', tool: 'status', status: 'inconclusive',
    before: 'success', after: 'success', expectedStatus: 'success', failures: [],
    reason: 'Baseline failed its declared checks.',
    checks: { before: { status: 'fail', failures: [{ path: '/structuredContent/enabled', check: 'equals', reason: 'assertion_failed' }] },
      after: { status: 'pass', failures: [] } } }];
  const markdown = renderMarkdown(report([], cases));
  assert.match(markdown, /baseline: \*\*fail\*\*; candidate: \*\*pass\*\*/);
  assert.match(markdown, /inconclusive/);
  assert.match(markdown, /Baseline \/structuredContent\/enabled/);
});

test('expected tool refusals remain compact passing cases', () => {
  const cases = [{ id: 'refused-write', tool: 'write', status: 'pass',
    before: 'tool_error', after: 'tool_error', expectedStatus: 'tool_error', failures: [] }];
  const markdown = renderMarkdown(report([], cases));
  assert.match(markdown, /Passed case IDs: refused-write/);
  assert.match(markdown, /explicitly expected tool errors/);
  assert.doesNotMatch(markdown, /\*\*pass\*\* refused-write/);
});

test('catalog measurements are separated from compatibility and efficiency claims', () => {
  const metrics = measureCatalogPayloads([], [{ name: 'lookup', description: 'PRIVATE-CONTENT', inputSchema: { type: 'object' } }]);
  const markdown = renderMarkdown(report([], [], { metrics }));
  assert.match(markdown, /Catalog payload measurement/);
  assert.match(markdown, /UTF-8 bytes/);
  assert.match(markdown, /not a token count, latency measurement, or proof of task efficiency/);
  assert.doesNotMatch(markdown, /PRIVATE-CONTENT/);
  assert.doesNotMatch(renderMarkdown(report([], [], { metrics, mode: 'compare-actions' })), /Catalog payload measurement/);
});
