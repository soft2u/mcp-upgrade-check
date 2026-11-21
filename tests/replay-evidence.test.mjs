import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCase, validateCases } from '../scripts/check.mjs';

const policyCase = {
  id: 'disabled-policy', tool: 'find_actions', arguments: { secret: 'PRIVATE-ARGUMENT' },
  assertions: [{ path: '/structuredContent/liveEnabled', op: 'equals', value: false }],
};
const success = liveEnabled => ({
  status: 'success', result: { content: [], structuredContent: { liveEnabled, secret: 'PRIVATE-RESULT' } },
});
const refusalCase = {
  id: 'reject-invalid-input', tool: 'configure', arguments: {}, expectedStatus: 'tool_error',
  assertions: [{ path: '/isError', op: 'equals', value: true },
    { path: '/structuredContent/code', op: 'equals', value: 'INVALID_PARAMS' }],
};
const refusal = (code = 'INVALID_PARAMS') => ({
  status: 'tool_error', result: { content: [], isError: true, structuredContent: { code } },
});

test('candidate checks remain observable after a failed baseline without claiming a regression or a fix', () => {
  const improved = evaluateCase(policyCase, success(true), success(false));
  const unchanged = evaluateCase(policyCase, success(true), success(true));
  assert.equal(improved.status, 'inconclusive');
  assert.equal(unchanged.status, 'inconclusive');
  assert.equal(improved.checks.before.status, 'fail');
  assert.equal(improved.checks.after.status, 'pass');
  assert.equal(unchanged.checks.before.status, 'fail');
  assert.equal(unchanged.checks.after.status, 'fail');
  assert.notDeepEqual(improved, unchanged);
  assert.doesNotMatch(JSON.stringify([improved, unchanged]), /PRIVATE-/);
});

test('candidate evidence survives unusable baseline transport and independent candidate failure', () => {
  const goodCandidate = evaluateCase(policyCase, { status: 'transport_error' }, success(false));
  assert.equal(goodCandidate.status, 'inconclusive');
  assert.equal(goodCandidate.checks.before.status, 'unavailable');
  assert.equal(goodCandidate.checks.after.status, 'pass');
  const failedCandidate = evaluateCase(policyCase, success(true), { status: 'not_run' });
  assert.equal(failedCandidate.status, 'inconclusive');
  assert.equal(failedCandidate.checks.before.status, 'fail');
  assert.equal(failedCandidate.checks.after.status, 'unavailable');
});

test('explicitly expected tool errors pass only when their assertions pass on both versions', () => {
  validateCases({ cases: [refusalCase] });
  const passed = evaluateCase(refusalCase, refusal(), refusal());
  assert.equal(passed.status, 'pass');
  assert.equal(passed.expectedStatus, 'tool_error');
  assert.equal(passed.before, 'tool_error');
  assert.equal(passed.after, 'tool_error');
  assert.equal(passed.checks.before.status, 'pass');
  assert.equal(passed.checks.after.status, 'pass');
  assert.equal(evaluateCase(refusalCase, refusal(), refusal('OTHER_ERROR')).status, 'regression');
  assert.equal(evaluateCase(refusalCase, refusal('OTHER_ERROR'), refusal()).status, 'inconclusive');
  assert.equal(evaluateCase(refusalCase, refusal(), success(false)).status, 'regression');
});

test('expected tool errors do not accept malformed responses, protocol failures, or transport failures', () => {
  for (const after of [
    { status: 'protocol_error' },
    { status: 'tool_error' },
    { status: 'tool_error', result: { content: [], isError: 'true' } },
    { status: 'tool_error', result: { content: [], isError: false } },
    { status: 'tool_error', result: { isError: true } },
  ]) {
    const report = evaluateCase(refusalCase, refusal(), after);
    assert.equal(report.status, 'regression');
    assert.equal(report.checks.after.status, 'fail');
  }
  assert.equal(evaluateCase(refusalCase, refusal(), { status: 'transport_error' }).status, 'inconclusive');
  assert.equal(evaluateCase(refusalCase, refusal(), { status: 'not_run' }).status, 'inconclusive');
  assert.equal(evaluateCase(refusalCase, refusal(), { status: 'missing_tool' }).status, 'regression');
});

test('default success expectation still treats baseline tool errors as inconclusive', () => {
  const legacy = { ...refusalCase };
  delete legacy.expectedStatus;
  assert.equal(evaluateCase(legacy, refusal(), refusal()).status, 'inconclusive');
  assert.equal(evaluateCase(legacy, refusal(), refusal()).expectedStatus, 'success');
});

test('negative path assertions distinguish absence from null, false, and inherited names', () => {
  const c = { id: 'no-secret', tool: 'inspect', arguments: {},
    assertions: [{ path: '/structuredContent/private~1key', op: 'notExists' }] };
  validateCases({ cases: [c] });
  const response = data => ({ status: 'success', result: { content: [], structuredContent: data } });
  assert.equal(evaluateCase(c, response({}), response({})).status, 'pass');
  for (const value of [null, false, '', 0]) {
    const report = evaluateCase(c, response({}), response({ 'private/key': value }));
    assert.equal(report.status, 'regression');
    assert.equal(report.checks.after.failures[0].reason, 'path_present');
  }
  const inherited = { ...c, assertions: [{ path: '/structuredContent/toString', op: 'notExists' }] };
  assert.equal(evaluateCase(inherited, response({}), response({})).status, 'pass');
});

test('case validation keeps error expectations and absence checks explicit and bounded', () => {
  for (const expectedStatus of ['protocol_error', 'transport_error', '', true, null])
    assert.throws(() => validateCases({ cases: [{ ...refusalCase, expectedStatus }] }), /expectedStatus/);
  assert.throws(() => validateCases({ cases: [{ ...refusalCase, assertions: [] }] }), /at least one/);
  for (const op of ['exists', 'notExists']) {
    assert.throws(() => validateCases({ cases: [{ ...policyCase, assertions: [{ path: '/x', op, value: null }] }] }), /omit value/);
  }
  assert.throws(() => validateCases({ cases: [{ ...policyCase, assertions: [{ path: '/x~2', op: 'notExists' }] }] }), /JSON pointers/);
});

test('selected-value changes are attributed only with a valid baseline and appear in candidate checks', () => {
  const c = { id: 'stable-field', tool: 'read', arguments: {}, comparePaths: ['/structuredContent/liveEnabled'] };
  const report = evaluateCase(c, success(false), success(true));
  assert.equal(report.status, 'regression');
  assert.equal(report.checks.before.status, 'pass');
  assert.equal(report.checks.after.status, 'fail');
  assert.deepEqual(report.failures, report.checks.after.failures);
  assert.equal(report.failures[0].reason, 'selected_value_changed');
  const incomplete = evaluateCase(c, { status: 'success', result: { content: [] } }, success(false));
  assert.equal(incomplete.status, 'inconclusive');
  assert.equal(incomplete.checks.before.failures[0].reason, 'baseline_path_missing');
  assert.equal(incomplete.checks.after.status, 'pass');
});
