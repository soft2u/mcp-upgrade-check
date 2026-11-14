/**
 * Conservative, dependency-free comparison of MCP tools/list catalogs.
 * "breaking" is a declared-contract risk, not a demonstrated call failure.
 * This is not a complete JSON Schema implication checker or schema validator.
 */

const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const escapePointer = value => String(value).replaceAll('~', '~0').replaceAll('/', '~1');
const child = (path, key) => `${path}/${escapePointer(key)}`;
const jsonTypes = ['null', 'boolean', 'object', 'array', 'string', 'number', 'integer'];
const schemaAnnotations = new Set(['title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly']);
const handled = new Set([
  'type', 'enum', 'const', 'required', 'properties', 'items', 'additionalProperties',
  'minimum', 'exclusiveMinimum', 'maximum', 'exclusiveMaximum', 'uniqueItems',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties',
  ...schemaAnnotations,
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(item => canonical(item));
  if (object(value)) {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  }
  return value;
}

const stable = value => JSON.stringify(canonical(value));
const equal = (a, b) => stable(a) === stable(b);

function validateSchema(schema, where, depth = 0) {
  if (depth > 64) throw new TypeError(`${where}: schema nesting exceeds 64 levels`);
  if (typeof schema === 'boolean') return;
  if (!object(schema)) throw new TypeError(`${where}: expected a JSON Schema object or boolean`);
  if (own(schema, 'type')) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.length || types.some(t => !jsonTypes.includes(t)) || new Set(types).size !== types.length) {
      throw new TypeError(`${where}/type: invalid JSON Schema type`);
    }
  }
  if (own(schema, 'required') && (!Array.isArray(schema.required)
    || schema.required.some(k => typeof k !== 'string')
    || new Set(schema.required).size !== schema.required.length)) {
    throw new TypeError(`${where}/required: expected unique property names`);
  }
  if (own(schema, 'enum') && (!Array.isArray(schema.enum) || !schema.enum.length
    || new Set(schema.enum.map(stable)).size !== schema.enum.length)) {
    throw new TypeError(`${where}/enum: expected a nonempty array of distinct values`);
  }
  if (own(schema, 'properties')) {
    if (!object(schema.properties)) throw new TypeError(`${where}/properties: expected an object`);
    for (const [name, sub] of Object.entries(schema.properties)) validateSchema(sub, `${where}/properties/${escapePointer(name)}`, depth + 1);
  }
  for (const key of ['additionalProperties', 'items']) {
    if (!own(schema, key)) continue;
    // Tuple items are valid in older dialects; comparison reports them for review.
    if (key === 'items' && Array.isArray(schema[key])) {
      for (const sub of schema[key]) validateSchema(sub, `${where}/items`, depth + 1);
    } else validateSchema(schema[key], `${where}/${key}`, depth + 1);
  }
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
    if (own(schema, key) && typeof schema[key] !== 'number') {
      // Draft-04 boolean exclusive bounds are deliberately unsupported, not treated as modern numeric bounds.
      if (key.startsWith('exclusive') && typeof schema[key] === 'boolean') continue;
      throw new TypeError(`${where}/${key}: expected a number`);
    }
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']) {
    if (own(schema, key) && (!Number.isSafeInteger(schema[key]) || schema[key] < 0)) {
      throw new TypeError(`${where}/${key}: expected a nonnegative integer`);
    }
  }
  if (own(schema, 'uniqueItems') && typeof schema.uniqueItems !== 'boolean') {
    throw new TypeError(`${where}/uniqueItems: expected a boolean`);
  }
}

function catalogMap(tools, side) {
  if (!Array.isArray(tools)) throw new TypeError(`${side}: expected an array of tools`);
  const result = new Map();
  for (const tool of tools) {
    if (!object(tool) || typeof tool.name !== 'string' || !tool.name.trim()) {
      throw new TypeError(`${side}: every tool needs a nonempty string name`);
    }
    if (result.has(tool.name)) throw new TypeError(`${side}: duplicate tool name ${tool.name}`);
    if (!object(tool.inputSchema)) throw new TypeError(`${side}/${tool.name}: inputSchema must be an object`);
    validateSchema(tool.inputSchema, `${side}/${tool.name}/inputSchema`);
    if (own(tool, 'outputSchema')) {
      if (!object(tool.outputSchema)) throw new TypeError(`${side}/${tool.name}: outputSchema must be an object`);
      validateSchema(tool.outputSchema, `${side}/${tool.name}/outputSchema`);
    }
    result.set(tool.name, tool);
  }
  return result;
}

function typeSet(schema) {
  const values = !own(schema, 'type') ? jsonTypes : Array.isArray(schema.type) ? schema.type : [schema.type];
  const set = new Set(values);
  if (set.has('number')) set.add('integer');
  return set;
}

const difference = (left, right) => [...left].filter(value => !right.has(value));

function finiteValues(schema) {
  if (own(schema, 'const')) {
    const constant = stable(schema.const);
    return new Set(!own(schema, 'enum') || schema.enum.some(v => stable(v) === constant) ? [constant] : []);
  }
  return own(schema, 'enum') ? new Set(schema.enum.map(stable)) : null;
}

function bounds(schema, lower) {
  const inclusiveKey = lower ? 'minimum' : 'maximum';
  const exclusiveKey = lower ? 'exclusiveMinimum' : 'exclusiveMaximum';
  let value = schema[inclusiveKey] ?? (lower ? -Infinity : Infinity);
  let exclusive = false;
  if (typeof schema[exclusiveKey] === 'number') {
    const candidate = schema[exclusiveKey];
    if ((lower ? candidate >= value : candidate <= value)) {
      value = candidate;
      exclusive = true;
    }
  }
  return { value, exclusive };
}

// Returns true if the newer bound permits fewer values, false if more, null if unchanged.
function boundDirection(before, after, lower) {
  if (before.value === after.value && before.exclusive === after.exclusive) return null;
  if (before.value === after.value) return after.exclusive;
  return lower ? after.value > before.value : after.value < before.value;
}

function isUnrestricted(schema) {
  return schema === true || (object(schema) && Object.keys(schema).every(key => schemaAnnotations.has(key)));
}

function diffSchema(before, after, direction, path, add, depth = 0) {
  if (equal(before, after)) return;
  if (depth > 64) {
    add('review', 'schema_depth_limit', path, 'Schema comparison reached its nesting limit.');
    return;
  }
  const change = (narrower, code, at, message) => add(
    (direction === 'input' ? narrower : !narrower) ? 'breaking' : 'info', code, at, message,
  );
  if (typeof before === 'boolean' || typeof after === 'boolean') {
    if (isUnrestricted(before) && isUnrestricted(after)) return;
    const narrower = after === false || before === true;
    change(narrower, narrower ? 'schema_narrowed' : 'schema_widened', path,
      `${direction === 'input' ? 'Input' : 'Output'} schema ${narrower ? 'restricts' : 'expands'} its declared set of values.`);
    return;
  }
  if (!object(before) || !object(after)) {
    add('review', 'schema_form_changed', path, 'Schema form changed; this comparator does not resolve tuple schemas or dialect conversion.');
    return;
  }

  const oldTypes = typeSet(before);
  const newTypes = typeSet(after);
  const removedTypes = difference(oldTypes, newTypes);
  const addedTypes = difference(newTypes, oldTypes);
  if (removedTypes.length || addedTypes.length) {
    const risky = direction === 'input' ? removedTypes.length : addedTypes.length;
    add(risky ? 'breaking' : 'info', 'type_changed', child(path, 'type'),
      `${direction === 'input' ? 'Input' : 'Output'} type set changed${removedTypes.length ? `; removed ${removedTypes.join(', ')}` : ''}${addedTypes.length ? `; added ${addedTypes.join(', ')}` : ''}.`);
  }

  const oldValues = finiteValues(before);
  const newValues = finiteValues(after);
  if ((oldValues === null) !== (newValues === null)
    || (oldValues && newValues && (difference(oldValues, newValues).length || difference(newValues, oldValues).length))) {
    const removes = oldValues === null || (newValues !== null && difference(oldValues, newValues).length > 0);
    const adds = newValues === null || (oldValues !== null && difference(newValues, oldValues).length > 0);
    const risky = direction === 'input' ? removes : adds;
    add(risky ? 'breaking' : 'info', 'allowed_values_changed', child(path, own(after, 'const') || own(before, 'const') ? 'const' : 'enum'),
      `${direction === 'input' ? 'Input' : 'Output'} enum/const ${removes && adds ? 'changes permitted values' : removes ? 'restricts permitted values' : 'expands permitted values'}.`);
  }

  const bothAllow = type => oldTypes.has(type) && newTypes.has(type);
  const compareObjects = bothAllow('object');
  const oldRequired = new Set(compareObjects ? before.required ?? [] : []);
  const newRequired = new Set(compareObjects ? after.required ?? [] : []);
  for (const name of difference(newRequired, oldRequired)) {
    change(true, 'required_added', child(path, 'required'),
      `Property ${JSON.stringify(name)} is now required${direction === 'input' ? '; existing calls may omit it' : '; the output promise is stronger'}.`);
  }
  for (const name of difference(oldRequired, newRequired)) {
    change(false, 'required_removed', child(path, 'required'),
      `Property ${JSON.stringify(name)} is no longer required${direction === 'output' ? '; consumers may rely on its presence' : ''}.`);
  }

  for (const lower of [true, false]) {
    if (!bothAllow('number') && !bothAllow('integer')) continue;
    const keys = lower ? ['minimum', 'exclusiveMinimum'] : ['maximum', 'exclusiveMaximum'];
    if (keys.some(key => typeof before[key] === 'boolean' || typeof after[key] === 'boolean')) {
      if (keys.some(key => !equal(before[key], after[key]))) add('review', 'legacy_bound_changed', child(path, keys[0]), 'Legacy boolean exclusive bounds require dialect-aware review.');
      continue;
    }
    const narrower = boundDirection(bounds(before, lower), bounds(after, lower), lower);
    if (narrower !== null) change(narrower, 'numeric_bound_changed', child(path, keys[0]),
      `${lower ? 'Lower' : 'Upper'} numeric bound ${narrower ? 'tightened' : 'relaxed'}.`);
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']) {
    const type = key.endsWith('Length') ? 'string' : key.endsWith('Items') ? 'array' : 'object';
    if (!bothAllow(type)) continue;
    const lower = key.startsWith('min');
    const oldValue = before[key] ?? (lower ? 0 : Infinity);
    const newValue = after[key] ?? (lower ? 0 : Infinity);
    if (oldValue !== newValue) change(lower ? newValue > oldValue : newValue < oldValue,
      'size_bound_changed', child(path, key), `${key} changed.`);
  }
  if (bothAllow('array') && (before.uniqueItems ?? false) !== (after.uniqueItems ?? false)) {
    change(after.uniqueItems === true, 'unique_items_changed', child(path, 'uniqueItems'),
      `Array uniqueness is ${after.uniqueItems ? 'now required' : 'no longer required'}.`);
  }

  const oldAdditional = compareObjects ? before.additionalProperties ?? true : true;
  const newAdditional = compareObjects ? after.additionalProperties ?? true : true;
  if (!equal(oldAdditional, newAdditional)) diffSchema(oldAdditional, newAdditional, direction,
    child(path, 'additionalProperties'), add, depth + 1);
  const oldProperties = compareObjects ? before.properties ?? {} : {};
  const newProperties = compareObjects ? after.properties ?? {} : {};
  for (const name of new Set([...Object.keys(oldProperties), ...Object.keys(newProperties)])) {
    const at = child(child(path, 'properties'), name);
    if (!own(oldProperties, name)) {
      if (direction === 'output' && oldAdditional === false && newProperties[name] !== false) {
        add('breaking', 'output_property_added_to_closed_schema', at,
          'New output property may violate the previous closed output schema; check any pattern-based rules.');
      } else if (direction === 'input' && isUnrestricted(oldAdditional) && !isUnrestricted(newProperties[name]) && !newRequired.has(name)) {
        add('review', 'optional_input_property_constrained', at,
          'New optional input property constrains a name that was previously open; check whether existing callers used it.');
      } else add('info', 'property_added', at, `Declared ${direction} property added.`);
      if (object(oldAdditional)) diffSchema(oldAdditional, newProperties[name], direction, at, add, depth + 1);
    } else if (!own(newProperties, name)) {
      if (direction === 'input' && newAdditional === false && oldProperties[name] !== false) {
        add('breaking', 'input_property_removed_from_closed_schema', at,
          'Existing input property may now be forbidden by additionalProperties: false; check any pattern-based rules.');
      } else if (direction === 'output' && isUnrestricted(newAdditional) && !isUnrestricted(oldProperties[name])) {
        add('breaking', 'output_property_unconstrained', at,
          'Previously constrained output property is now unconstrained if present.');
      } else add('review', 'property_removed', at, `Declared ${direction} property removed; check dependent workflows.`);
      if (object(newAdditional)) diffSchema(oldProperties[name], newAdditional, direction, at, add, depth + 1);
    } else diffSchema(oldProperties[name], newProperties[name], direction, at, add, depth + 1);
  }

  if (bothAllow('array') && !equal(before.items, after.items)) {
    diffSchema(before.items ?? true, after.items ?? true, direction, child(path, 'items'), add, depth + 1);
  }

  for (const key of schemaAnnotations) {
    if (!equal(before[key], after[key])) add('review', 'schema_annotation_changed', child(path, key),
      `${key} changed; annotations can affect agent choices or application behavior without changing schema validity.`);
  }
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!handled.has(key) && !equal(before[key], after[key])) add('review', 'unsupported_keyword_changed', child(path, key),
      `${key} changed; compatibility for this schema keyword is not resolved by this comparator.`);
  }
}

/** Compare a declared schema independently, without fabricating a surrounding tool. */
export function compareSchemas(before, after, { direction = 'input', tool = '*', path = '' } = {}) {
  if (!['input', 'output'].includes(direction)) throw new TypeError('Schema direction must be input or output.');
  validateSchema(before, 'before');
  validateSchema(after, 'after');
  const findings = [];
  diffSchema(before, after, direction, path, (severity, code, at, message) => findings.push({ severity, code, tool, path: at, message }));
  return findings;
}

/** Compare complete arrays of tool definitions. Throws TypeError for malformed catalogs. */
export function compareCatalogs(beforeTools, afterTools) {
  const before = catalogMap(beforeTools, 'before');
  const after = catalogMap(afterTools, 'after');
  const findings = [];
  for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const path = `/tools/${escapePointer(name)}`;
    const add = (severity, code, at, message) => findings.push({ severity, code, tool: name, path: at, message });
    if (!after.has(name)) {
      add('breaking', 'tool_removed', path, 'Tool is no longer advertised; existing calls to this name may fail.');
      continue;
    }
    if (!before.has(name)) {
      add('info', 'tool_added', path, 'New tool advertised. Tool selection behavior may still need a workflow check.');
      continue;
    }
    const oldTool = before.get(name);
    const newTool = after.get(name);
    diffSchema(oldTool.inputSchema, newTool.inputSchema, 'input', child(path, 'inputSchema'), add);
    if (own(oldTool, 'outputSchema') && own(newTool, 'outputSchema')) {
      diffSchema(oldTool.outputSchema, newTool.outputSchema, 'output', child(path, 'outputSchema'), add);
    } else if (own(oldTool, 'outputSchema') !== own(newTool, 'outputSchema')) {
      add(own(newTool, 'outputSchema') ? 'review' : 'breaking',
        own(newTool, 'outputSchema') ? 'output_schema_added' : 'output_schema_removed', child(path, 'outputSchema'),
        own(newTool, 'outputSchema') ? 'An output contract is now advertised; verify structured results and existing consumers.'
          : 'The previously advertised output contract was removed; verify consumers that rely on it.');
    }
    for (const key of new Set([...Object.keys(oldTool), ...Object.keys(newTool)])) {
      if (['name', 'inputSchema', 'outputSchema'].includes(key) || equal(oldTool[key], newTool[key])) continue;
      add('review', 'tool_metadata_changed', child(path, key),
        `Tool ${key} changed; inspect effects on selection, execution, permissions, or presentation.`);
    }
  }
  const order = { breaking: 0, review: 1, info: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]
    || a.tool.localeCompare(b.tool) || a.path.localeCompare(b.path) || a.code.localeCompare(b.code));
}
