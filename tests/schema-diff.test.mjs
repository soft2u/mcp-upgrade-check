import test from 'node:test';
import assert from 'node:assert/strict';
import { compareCatalogs } from '../scripts/schema-diff.mjs';

const tool = (inputSchema = { type: 'object' }, outputSchema) => ({
  name: 'lookup', inputSchema, ...(outputSchema === undefined ? {} : { outputSchema }),
});
const input = (before, after) => compareCatalogs([tool(before)], [tool(after)]);
const output = (before, after) => compareCatalogs([tool(undefined, before)], [tool(undefined, after)]);
const has = (findings, code, severity) => findings.some(f => f.code === code && f.severity === severity);
const breaking = findings => findings.filter(f => f.severity === 'breaking');

test('tool removal is a contract risk and additions are informational', () => {
  assert.ok(has(compareCatalogs([tool()], []), 'tool_removed', 'breaking'));
  assert.ok(has(compareCatalogs([], [tool()]), 'tool_added', 'info'));
});

test('object key, required-list and enum reordering do not produce findings', () => {
  const before = { type: 'object', required: ['b', 'a'], properties: { a: { enum: ['two', 'one'] }, b: { type: 'number' } } };
  const after = { properties: { b: { type: 'number' }, a: { enum: ['one', 'two'] } }, required: ['a', 'b'], type: 'object' };
  assert.deepEqual(input(before, after), []);
});

test('required changes use input contravariance and output covariance', () => {
  const optional = { type: 'object', properties: { id: { type: 'string' } } };
  const required = { ...optional, required: ['id'] };
  assert.ok(has(input(optional, required), 'required_added', 'breaking'));
  assert.equal(breaking(input(required, optional)).length, 0);
  assert.ok(has(output(required, optional), 'required_removed', 'breaking'));
  assert.equal(breaking(output(optional, required)).length, 0);
});

test('integer is a subset of number and equivalent unions do not churn', () => {
  assert.ok(has(input({ type: 'number' }, { type: 'integer' }), 'type_changed', 'breaking'));
  assert.equal(breaking(output({ type: 'number' }, { type: 'integer' })).length, 0);
  assert.ok(has(output({ type: 'integer' }, { type: 'number' }), 'type_changed', 'breaking'));
  assert.deepEqual(input({ type: ['number', 'integer'] }, { type: 'number' }), []);
});

test('enum narrowing breaks inputs while widening threatens output consumers', () => {
  assert.ok(has(input({ enum: ['a', 'b'] }, { enum: ['a'] }), 'allowed_values_changed', 'breaking'));
  assert.equal(breaking(output({ enum: ['a', 'b'] }, { enum: ['a'] })).length, 0);
  assert.ok(has(output({ enum: ['a'] }, { enum: ['a', 'b'] }), 'allowed_values_changed', 'breaking'));
  assert.ok(has(input({}, { const: 1 }), 'allowed_values_changed', 'breaking'));
  assert.deepEqual(input({ enum: [{ x: 1, y: 2 }] }, { const: { y: 2, x: 1 } }), []);
});

test('effective numeric bounds account for exclusive and inclusive bounds together', () => {
  assert.ok(has(input({ minimum: 0 }, { exclusiveMinimum: 0 }), 'numeric_bound_changed', 'breaking'));
  assert.equal(breaking(input({ exclusiveMinimum: 0 }, { minimum: 0 })).length, 0);
  assert.equal(breaking(input({ minimum: 0, exclusiveMinimum: 5 }, { minimum: 1, exclusiveMinimum: 5 })).length, 0);
  assert.ok(has(output({ maximum: 10 }, { maximum: 20 }), 'numeric_bound_changed', 'breaking'));
});

test('nested properties, arrays and escaped JSON pointer names retain direction', () => {
  const before = { type: 'object', properties: { 'a/b~c': { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' } } } } } };
  const after = structuredClone(before);
  after.properties['a/b~c'].items.properties.id.type = 'number';
  const findings = output(before, after);
  assert.ok(findings.some(f => f.severity === 'breaking' && f.path === '/tools/lookup/outputSchema/properties/a~1b~0c/items/properties/id/type'));
  assert.equal(breaking(input(before, after)).length, 0);
});

test('additionalProperties and removed parameters respect closed schemas', () => {
  assert.ok(has(input({ type: 'object' }, { type: 'object', additionalProperties: false }), 'schema_narrowed', 'breaking'));
  assert.ok(has(output({ additionalProperties: false }, {}), 'schema_widened', 'breaking'));
  assert.ok(has(input({ properties: { id: { type: 'string' } }, additionalProperties: false }, { additionalProperties: false }), 'input_property_removed_from_closed_schema', 'breaking'));
});

test('optional input additions distinguish closed schemas from previously open names', () => {
  const closed = { type: 'object', additionalProperties: false };
  const added = { ...closed, properties: { limit: { type: 'integer' } } };
  assert.equal(breaking(input(closed, added)).length, 0);
  assert.ok(has(input(closed, added), 'property_added', 'info'));
  assert.ok(has(input({ type: 'object' }, { type: 'object', properties: { limit: { type: 'integer' } } }), 'optional_input_property_constrained', 'review'));
  assert.ok(has(output(closed, added), 'output_property_added_to_closed_schema', 'breaking'));
});

test('removing an output field definition must not claim its type remains guaranteed', () => {
  assert.ok(has(output({ properties: { id: { type: 'string' } } }, {}), 'output_property_unconstrained', 'breaking'));
});

test('unresolved refs and combinators are review items, not compatibility proofs', () => {
  const findings = input({ $ref: '#/$defs/A', $defs: { A: { type: 'string' } } }, { $ref: '#/$defs/A', $defs: { A: { type: 'number' } } });
  assert.ok(has(findings, 'unsupported_keyword_changed', 'review'));
  assert.equal(breaking(findings).length, 0);
  assert.ok(has(input({ anyOf: [{ type: 'string' }] }, { anyOf: [{ type: 'number' }] }), 'unsupported_keyword_changed', 'review'));
});

test('description, defaults and tool annotations require behavioral review', () => {
  const before = { ...tool({ properties: { n: { type: 'integer', default: 1 } } }), description: 'Find one record', annotations: { readOnlyHint: true } };
  const after = { ...tool({ properties: { n: { type: 'integer', default: 2 } } }), description: 'Find all records', annotations: { readOnlyHint: false } };
  const findings = compareCatalogs([before], [after]);
  assert.ok(has(findings, 'schema_annotation_changed', 'review'));
  assert.equal(findings.filter(f => f.code === 'tool_metadata_changed').length, 2);
  assert.equal(breaking(findings).length, 0);
});

test('output contract removal is a risk; addition needs result verification', () => {
  assert.ok(has(compareCatalogs([tool(undefined, { type: 'object' })], [tool()]), 'output_schema_removed', 'breaking'));
  assert.ok(has(compareCatalogs([tool()], [tool(undefined, { type: 'object' })]), 'output_schema_added', 'review'));
});

test('size and uniqueness restrictions are directional', () => {
  assert.ok(has(input({ minLength: 1 }, { minLength: 3 }), 'size_bound_changed', 'breaking'));
  assert.equal(breaking(output({ minLength: 1 }, { minLength: 3 })).length, 0);
  assert.ok(has(output({ uniqueItems: true }, {}), 'unique_items_changed', 'breaking'));
  assert.deepEqual(input({}, { minItems: 0, uniqueItems: false }), []);
});

test('boolean nested schemas and tuple changes are handled conservatively', () => {
  assert.ok(has(input({ properties: { x: true } }, { properties: { x: false } }), 'schema_narrowed', 'breaking'));
  assert.deepEqual(input({ items: {} }, { items: true }), []);
  assert.ok(has(input({ items: [{ type: 'string' }] }, { items: [{ type: 'number' }] }), 'schema_form_changed', 'review'));
});

test('malformed tools and duplicate names fail closed', () => {
  for (const catalog of [null, {}, [tool(), tool()], [{ name: 'bad' }], [{ name: 'bad', inputSchema: [] }], [tool({ type: 'str' })], [tool({ required: 'id' })], [tool({ properties: { x: null } })]]) {
    assert.throws(() => compareCatalogs(catalog, []), TypeError);
  }
  assert.throws(() => compareCatalogs([], [{ ...tool(), outputSchema: null }]), TypeError);
});

test('constraints inapplicable to both declared type domains do not create false risks', () => {
  assert.deepEqual(input({ type: 'object' }, { type: 'object', minLength: 5 }), []);
  assert.deepEqual(input({ type: 'string' }, { type: 'string', required: ['x'], items: false, minimum: 5 }), []);
  assert.equal(breaking(output({ type: ['object', 'string'], required: ['x'] }, { type: 'string' })).length, 0);
});

test('enum values retain data-array order even when their property is named required', () => {
  const findings = input({ const: { required: ['a', 'b'] } }, { const: { required: ['b', 'a'] } });
  assert.ok(has(findings, 'allowed_values_changed', 'breaking'));
  assert.deepEqual(input({ enum: [{ x: 1 }, { x: 2 }] }, { enum: [{ x: 2 }, { x: 1 }] }), []);
});
