import { compareSchemas } from './schema-diff.mjs';
import { isDeepStrictEqual } from 'node:util';

const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const escaped = value => String(value).replaceAll('~', '~0').replaceAll('/', '~1');
const identity = source => [source.sourceId, source.executionTool, source.name].map(encodeURIComponent).join('::');

function keys(value, allowed, label) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError(`${label} contains an invalid or unknown field.`);
}

function pointer(path) {
  if (typeof path !== 'string' || (path !== '' && !path.startsWith('/')) || /~(?:[^01]|$)/.test(path)) {
    throw new TypeError('Discovery paths must be RFC 6901 JSON Pointers.');
  }
}

function at(value, path) {
  if (path === '') return { exists: true, value };
  for (const encoded of path.slice(1).split('/')) {
    const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (value === null || typeof value !== 'object' || !own(value, key)) return { exists: false };
    if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) return { exists: false };
    value = value[key];
  }
  return { exists: true, value };
}

/** Validate explicit discovery adapters. Nothing is inferred from tool annotations. */
export function validateDiscoveryManifest(input) {
  keys(input, ['sources'], 'Discovery manifest');
  if (!Array.isArray(input.sources) || !input.sources.length) throw new TypeError('Discovery manifest needs a nonempty sources array.');
  const ids = new Set();
  const sources = input.sources.map(source => {
    keys(source, ['id', 'discoveryTool', 'executionTool', 'arguments', 'actionsPath', 'fields', 'completeness', 'successPath', 'successValue'], 'Discovery source');
    for (const key of ['id', 'discoveryTool', 'executionTool']) {
      if (!nonempty(source[key])) throw new TypeError(`Discovery source needs a nonempty ${key}.`);
    }
    if (ids.has(source.id)) throw new TypeError('Discovery source ids must be unique.');
    ids.add(source.id);
    if (!object(source.arguments)) throw new TypeError('Discovery arguments must be an object.');
    pointer(source.actionsPath);
    keys(source.fields, ['name', 'description', 'inputSchema', 'outputSchema', 'metadata'], 'Discovery fields');
    if (!nonempty(source.fields.name)) throw new TypeError('Discovery fields must map an action name.');
    for (const [key, field] of Object.entries(source.fields)) {
      if (key === 'metadata') continue;
      if (!nonempty(field)) throw new TypeError('Discovery field mappings must be nonempty property names.');
      if (field.startsWith('/')) throw new TypeError('Discovery fields use property names, not JSON Pointers.');
    }
    if (own(source.fields, 'metadata')) {
      if (!object(source.fields.metadata) || !Object.keys(source.fields.metadata).length) {
        throw new TypeError('Discovery metadata must map at least one label to a descriptor property name.');
      }
      for (const [label, field] of Object.entries(source.fields.metadata)) {
        if (!nonempty(label) || !nonempty(field)) throw new TypeError('Discovery metadata labels and property names must be nonempty strings.');
        if (field.startsWith('/')) throw new TypeError('Discovery metadata fields use property names, not JSON Pointers.');
      }
    }
    if (own(source, 'successPath')) pointer(source.successPath);
    if (own(source, 'successValue') && !own(source, 'successPath')) throw new TypeError('successValue requires successPath.');
    if (own(source, 'successValue') && !['string', 'number', 'boolean'].includes(typeof source.successValue) && source.successValue !== null) {
      throw new TypeError('Discovery successValue must be a JSON scalar.');
    }
    const completeness = source.completeness ?? { mode: 'unknown', allActionsRequested: false };
    keys(completeness, ['mode', 'allActionsRequested', 'limit', 'totalPath', 'nextCursorPath', 'truncatedPath'], 'Discovery completeness');
    if (!['unknown', 'unpaginated', 'limit'].includes(completeness.mode)) throw new TypeError('Discovery completeness mode must be unknown, unpaginated, or limit.');
    if (completeness.allActionsRequested !== undefined && typeof completeness.allActionsRequested !== 'boolean') throw new TypeError('allActionsRequested must be boolean.');
    if (completeness.mode === 'limit' && (!Number.isSafeInteger(completeness.limit) || completeness.limit < 1)) throw new TypeError('Limit completeness requires a positive integer limit.');
    if (own(completeness, 'limit') && (!Number.isSafeInteger(completeness.limit) || completeness.limit < 1)) throw new TypeError('Discovery limit must be a positive integer.');
    for (const key of ['totalPath', 'nextCursorPath', 'truncatedPath']) {
      if (own(completeness, key)) pointer(completeness[key]);
    }
    return { ...source, fields: { ...source.fields,
      ...(source.fields.metadata ? { metadata: { ...source.fields.metadata } } : {}),
    }, completeness: { allActionsRequested: false, ...completeness } };
  });
  return { sources };
}

/** Call only the explicitly configured discovery tools. The caller owns launch authorization. */
export async function discoverActions(client, tools, manifest) {
  const { sources } = validateDiscoveryManifest(manifest);
  if (!Array.isArray(tools)) throw new TypeError('Discovery requires the session tool catalog.');
  const names = new Set(tools.map(tool => tool.name));
  const captures = Object.create(null);
  for (const source of sources) {
    if (!names.has(source.discoveryTool)) {
      captures[source.id] = { status: 'missing_discovery_tool' };
      continue;
    }
    if (client.fatal) {
      captures[source.id] = { status: 'not_run' };
      continue;
    }
    const executionToolAvailable = names.has(source.executionTool);
    try {
      const response = await client.request('tools/call', { name: source.discoveryTool, arguments: source.arguments });
      if (!object(response) || own(response, 'error') || !object(response.result) || !Array.isArray(response.result.content)
        || (response.result.isError !== undefined && typeof response.result.isError !== 'boolean')) {
        captures[source.id] = { status: 'protocol_error', executionToolAvailable };
      } else {
        captures[source.id] = { status: response.result.isError ? 'tool_error' : 'success', result: response.result, executionToolAvailable };
      }
    } catch {
      captures[source.id] = { status: 'transport_error', executionToolAvailable };
    }
  }
  return captures;
}

function unwrap(capture) {
  if (!object(capture)) throw new TypeError('Each discovery capture must be an object.');
  if (own(capture, 'status')) {
    if (capture.status !== 'success') {
      const known = ['missing_discovery_tool', 'missing_execution_tool', 'not_run', 'transport_error', 'protocol_error', 'tool_error'];
      return { unavailable: known.includes(capture.status) ? capture.status : 'capture_failed' };
    }
    if (!object(capture.result)) throw new TypeError('Successful discovery capture must contain a tool result.');
    if (capture.executionToolAvailable !== undefined && typeof capture.executionToolAvailable !== 'boolean') throw new TypeError('executionToolAvailable must be boolean.');
    return { result: capture.result, executionToolAvailable: capture.executionToolAvailable };
  }
  if (own(capture, 'jsonrpc')) {
    if (capture.jsonrpc !== '2.0' || own(capture, 'result') === own(capture, 'error')) throw new TypeError('Malformed discovery JSON-RPC response.');
    if (own(capture, 'error')) return { unavailable: 'protocol_error' };
    if (!object(capture.result)) throw new TypeError('Discovery JSON-RPC result must be an object.');
    return { result: capture.result };
  }
  if (own(capture, 'structuredContent') || own(capture, 'content')) return { result: capture };
  if (object(capture.result)) return { result: capture.result };
  throw new TypeError('Discovery capture must contain a tool result or JSON-RPC response.');
}

function completenessOf(source, result, count, executionToolAvailable) {
  const c = source.completeness;
  const reasons = [];
  let proven = false;
  if (!c.allActionsRequested) reasons.push('all_actions_request_unverified');
  if (executionToolAvailable === false) reasons.push('execution_tool_missing');
  if (own(c, 'nextCursorPath')) {
    const cursor = at(result, c.nextCursorPath);
    if (cursor.exists && cursor.value !== undefined && cursor.value !== null && cursor.value !== '') reasons.push('remaining_cursor');
  }
  if (own(c, 'truncatedPath')) {
    const flag = at(result, c.truncatedPath);
    if (!flag.exists) reasons.push('truncation_flag_missing');
    else if (typeof flag.value !== 'boolean') throw new TypeError('Discovery truncation flag must be boolean.');
    else if (flag.value) reasons.push('reported_truncated');
    else proven = true;
  }
  if (own(c, 'totalPath')) {
    const total = at(result, c.totalPath);
    if (!total.exists) reasons.push('reported_total_missing');
    else if (!Number.isSafeInteger(total.value) || total.value < 0) throw new TypeError('Discovery total must be a nonnegative integer.');
    else if (total.value !== count) reasons.push(total.value > count ? 'reported_total_exceeds_count' : 'reported_total_smaller_than_count');
    else proven = true;
  }
  if (c.mode === 'unpaginated') proven = true;
  if (c.mode === 'limit') {
    if (count < c.limit) proven = true;
    else if (!proven) reasons.push('limit_reached');
  }
  if (!proven) reasons.push('completeness_unproven');
  return {
    status: reasons.length ? 'partial' : 'complete', actionCount: count,
    reasons: reasons.length ? [...new Set(reasons)] : [c.mode === 'limit' && count < c.limit ? 'fewer_than_declared_limit' : c.mode === 'unpaginated' ? 'declared_unpaginated' : 'explicit_completeness_signal'],
  };
}

/** Normalize explicit capture adapters, preserving absent schemas as absent. */
export function normalizeDiscovery(capture, manifest) {
  const { sources } = validateDiscoveryManifest(manifest);
  if (!object(capture)) throw new TypeError('Discovery capture must map source ids or discovery-tool names to responses.');
  const toolCounts = new Map();
  for (const source of sources) toolCounts.set(source.discoveryTool, (toolCounts.get(source.discoveryTool) ?? 0) + 1);
  const normalizedSources = [], actions = [];
  for (const source of sources) {
    const base = { sourceId: source.id, discoveryTool: source.discoveryTool, executionTool: source.executionTool, actions: [] };
    let entry;
    if (own(capture, source.id)) entry = capture[source.id];
    else if (own(capture, source.discoveryTool)) {
      if (toolCounts.get(source.discoveryTool) > 1) throw new TypeError('Multiple adapters use this discovery tool; capture by source id to avoid ambiguity.');
      entry = capture[source.discoveryTool];
    }
    if (entry === undefined) {
      normalizedSources.push({ ...base, coverage: { status: 'unavailable', actionCount: 0, reasons: ['capture_missing'] } });
      continue;
    }
    const unwrapped = unwrap(entry);
    const result = unwrapped.result;
    let unavailable = unwrapped.unavailable;
    if (result && own(result, 'isError') && typeof result.isError !== 'boolean') throw new TypeError('Discovery isError must be boolean.');
    if (result?.isError === true) unavailable = 'tool_error';
    if (result && own(source, 'successPath')) {
      const status = at(result, source.successPath);
      if (!status.exists || status.value !== (own(source, 'successValue') ? source.successValue : true)) unavailable = 'discovery_reported_failure';
    }
    if (unavailable) {
      normalizedSources.push({ ...base, coverage: { status: 'unavailable', actionCount: 0, reasons: [unavailable] } });
      continue;
    }
    const list = at(result, source.actionsPath);
    if (!list.exists) {
      normalizedSources.push({ ...base, coverage: { status: 'unavailable', actionCount: 0, reasons: ['action_list_missing'] } });
      continue;
    }
    if (!Array.isArray(list.value)) throw new TypeError('Configured discovery actionsPath must select an array.');
    const seen = new Set();
    for (const item of list.value) {
      if (!object(item) || !nonempty(item[source.fields.name])) throw new TypeError('Every discovered action must have its mapped nonempty name.');
      const action = { sourceId: source.id, executionTool: source.executionTool, name: item[source.fields.name] };
      action.id = identity(action);
      if (seen.has(action.id)) throw new TypeError(`Duplicate discovered action identity: ${action.id}`);
      seen.add(action.id);
      for (const [field, direction] of [['inputSchema', 'input'], ['outputSchema', 'output']]) {
        const mapped = source.fields[field];
        if (mapped && own(item, mapped)) {
          const schema = item[mapped];
          if (!object(schema) && typeof schema !== 'boolean') throw new TypeError(`Discovered ${field} must be a JSON Schema object or boolean when present.`);
          compareSchemas(schema, schema, { direction, tool: action.id });
          action[field] = schema;
        }
      }
      if (source.fields.description && own(item, source.fields.description)) {
        if (typeof item[source.fields.description] !== 'string') throw new TypeError('Discovered description must be a string when present.');
        action.description = item[source.fields.description];
      }
      if (source.fields.metadata) {
        action.metadata = Object.fromEntries(Object.entries(source.fields.metadata).map(([label, field]) => [label,
          own(item, field) ? { field, present: true, value: item[field] } : { field, present: false },
        ]));
      }
      base.actions.push(action);
      actions.push(action);
    }
    normalizedSources.push({ ...base, coverage: completenessOf(source, result, base.actions.length, unwrapped.executionToolAvailable) });
  }
  return { sources: normalizedSources, actions, counts: countActions(actions), coverage: normalizedSources.map(source => ({ sourceId: source.sourceId, ...source.coverage })) };
}

function countActions(actions) {
  return {
    actions: actions.length,
    withInputSchema: actions.filter(action => own(action, 'inputSchema')).length,
    withOutputSchema: actions.filter(action => own(action, 'outputSchema')).length,
  };
}

function presence(action, metadataLabels = []) {
  const result = action ? { present: true, inputSchema: own(action, 'inputSchema') ? 'present' : 'missing', outputSchema: own(action, 'outputSchema') ? 'present' : 'missing' }
    : { present: false, inputSchema: 'absent', outputSchema: 'absent' };
  if (metadataLabels.length) result.metadata = Object.fromEntries(metadataLabels.map(label => [label,
    !action ? 'absent' : !own(action.metadata ?? {}, label) ? 'unmapped' : action.metadata[label].present ? 'present' : 'missing',
  ]));
  return result;
}

/** Compare observed contracts. Incomplete candidate discovery never confirms removals. */
export function compareDiscovered(before, after) {
  if (!Array.isArray(before?.sources) || !Array.isArray(after?.sources) || !Array.isArray(before.actions) || !Array.isArray(after.actions)) {
    throw new TypeError('compareDiscovered requires normalized discovery captures.');
  }
  const oldSources = new Map(before.sources.map(source => [source.sourceId, source]));
  const newSources = new Map(after.sources.map(source => [source.sourceId, source]));
  const oldActions = new Map(before.actions.map(action => [action.id, action]));
  const newActions = new Map(after.actions.map(action => [action.id, action]));
  const findings = [], coverage = [], inventory = [];
  const unavailable = { status: 'unavailable', actionCount: 0, reasons: ['source_missing'] };
  for (const sourceId of [...new Set([...oldSources.keys(), ...newSources.keys()])].sort()) {
    const oldSource = oldSources.get(sourceId), newSource = newSources.get(sourceId), source = newSource ?? oldSource;
    const entry = { sourceId, discoveryTool: source.discoveryTool, executionTool: source.executionTool,
      before: oldSource?.coverage ?? unavailable, after: newSource?.coverage ?? unavailable };
    coverage.push(entry);
    if (entry.before.status !== 'complete' || entry.after.status !== 'complete') {
      findings.push({ severity: 'review', code: 'discovery_coverage_incomplete', tool: source.executionTool,
        path: `/discovery/${escaped(sourceId)}`, message: 'Nested-action discovery is incomplete or unavailable on at least one side; inspect coverage before interpreting absent actions.' });
    }
  }
  for (const id of [...new Set([...oldActions.keys(), ...newActions.keys()])].sort()) {
    const oldAction = oldActions.get(id), newAction = newActions.get(id), action = newAction ?? oldAction;
    const path = `/tools/${escaped(id)}`;
    const metadataLabels = [...new Set([...Object.keys(oldAction?.metadata ?? {}), ...Object.keys(newAction?.metadata ?? {})])].sort();
    inventory.push({ id, sourceId: action.sourceId, executionTool: action.executionTool, name: action.name,
      before: presence(oldAction, metadataLabels), after: presence(newAction, metadataLabels),
      ...(metadataLabels.length ? { metadataFields: Object.fromEntries(metadataLabels.map(label => [label, {
        before: oldAction?.metadata?.[label]?.field ?? null, after: newAction?.metadata?.[label]?.field ?? null,
      }])) } : {}),
    });
    const add = (severity, code, suffix, message) => findings.push({ severity, code, tool: id, path: path + suffix, message });
    if (!newAction) {
      const complete = newSources.get(action.sourceId)?.coverage.status === 'complete';
      add(complete ? 'breaking' : 'review', complete ? 'discovered_action_removed' : 'discovered_action_not_observed', '', complete
        ? 'Previously observed action is absent from a complete candidate discovery response; callers using this parent tool and action name may fail.'
        : 'Previously observed action was not returned by incomplete candidate discovery; removal is not established.');
      continue;
    }
    if (!oldAction) {
      const complete = oldSources.get(action.sourceId)?.coverage.status === 'complete';
      add('info', complete ? 'discovered_action_added' : 'discovered_action_newly_observed', '', complete
        ? 'New action is advertised under this executable tool.'
        : 'Action is observed in the candidate; incomplete baseline discovery cannot establish that it is newly added.');
    }
    for (const [field, direction] of [['inputSchema', 'input'], ['outputSchema', 'output']]) {
      if (oldAction && own(oldAction, field) && own(newAction, field)) {
        findings.push(...compareSchemas(oldAction[field], newAction[field], { direction, tool: id, path: path + '/' + field }));
      } else if (field === 'inputSchema' || (oldAction && own(oldAction, field)) || own(newAction, field)) {
        if (!own(newAction, field) || (oldAction && !own(oldAction, field))) {
          add('review', `discovered_${direction}_schema_missing`, '/' + field,
            `An observed action has no ${direction} schema on at least one side. Schema compatibility is unverified; absence of schema metadata does not mean the action was removed.`);
        }
      }
    }
    if (oldAction && oldAction.description !== newAction.description) {
      add('review', 'tool_metadata_changed', '/description', 'Action description changed; inspect effects on selection or execution guidance.');
    }
    if (oldAction) for (const label of metadataLabels) {
      const oldMetadata = oldAction.metadata?.[label], newMetadata = newAction.metadata?.[label];
      const suffix = '/metadata/' + escaped(label);
      if (!oldMetadata || !newMetadata || oldMetadata.field !== newMetadata.field) {
        add('review', 'action_metadata_mapping_changed', suffix,
          'Metadata mapping differs between captures; a change in the descriptor value is not established.');
      } else if (oldMetadata.present !== newMetadata.present) {
        add('review', newMetadata.present ? 'action_metadata_added' : 'action_metadata_removed', suffix,
          `Mapped action metadata is ${newMetadata.present ? 'now present' : 'no longer present'}; review execution requirements or behavior. Values are omitted.`);
      } else if (oldMetadata.present && !isDeepStrictEqual(oldMetadata.value, newMetadata.value)) {
        add('review', 'action_metadata_changed', suffix,
          'Mapped action metadata changed; review execution requirements or behavior. Values are omitted.');
      }
    }
  }
  const oldCounts = countActions(before.actions), newCounts = countActions(after.actions);
  return { findings,
    counts: { before: oldCounts.actions, after: newCounts.actions, beforeWithInputSchema: oldCounts.withInputSchema,
      afterWithInputSchema: newCounts.withInputSchema, beforeWithOutputSchema: oldCounts.withOutputSchema, afterWithOutputSchema: newCounts.withOutputSchema },
    coverage, inventory };
}
