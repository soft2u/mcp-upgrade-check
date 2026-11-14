#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { compareCatalogs } from './schema-diff.mjs';
import { readServerConfig, StdioClient } from './stdio.mjs';
import { renderMarkdown, summarizeFindings } from './report.mjs';
import { validateDiscoveryManifest, discoverActions, normalizeDiscovery, compareDiscovered } from './discovery.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const readJSON = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const LIMITATIONS = [
  'Static findings describe declared contract risks, not proven failures of every consumer.',
  'Schema analysis covers common keywords; it is not a complete JSON Schema subtype checker.',
  'Replay checks only the listed cases and assertions. No check proves an upgrade universally safe.',
  'No automatic output-schema validation, auth-flow, remote HTTP, subscription, task, or concurrent-session testing.',
];

export function extractCatalog(value) {
  if (!object(value)) throw new Error('Catalog must be an object containing tools or result.tools.');
  if (Object.hasOwn(value, 'error')) throw new Error('Catalog contains an error response.');
  const result = Object.hasOwn(value, 'tools') ? value : value.result;
  if (!object(result) || !Array.isArray(result.tools)) throw new Error('Catalog must contain tools or result.tools.');
  if (Object.hasOwn(result, 'nextCursor')) throw new Error('Catalog is paginated and incomplete. Merge all pages and omit nextCursor.');
  return result.tools;
}

function validatePointer(path) {
  if (typeof path !== 'string' || (path !== '' && !path.startsWith('/')) || /~(?:[^01]|$)/.test(path))
    throw new Error('Assertion paths must be RFC 6901 JSON pointers.');
}

export function atPointer(value, path) {
  validatePointer(path);
  if (path === '') return { exists: true, value };
  for (const encoded of path.slice(1).split('/')) {
    const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return { exists: false };
    if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) return { exists: false };
    value = value[key];
  }
  return { exists: true, value };
}

export function validateCases(input) {
  if (!object(input) || Object.keys(input).some(k => k !== 'cases') || !Array.isArray(input.cases) || !input.cases.length)
    throw new Error('Case file must contain a nonempty cases array.');
  const ids = new Set();
  for (const c of input.cases) {
    if (!object(c) || Object.keys(c).some(k => !['id', 'tool', 'arguments', 'assertions', 'comparePaths'].includes(k)))
      throw new Error('Case contains an unknown field.');
    if (typeof c.id !== 'string' || !c.id || ids.has(c.id)) throw new Error('Case ids must be nonempty and unique.');
    ids.add(c.id);
    if (typeof c.tool !== 'string' || !c.tool || !object(c.arguments)) throw new Error('Each case needs a tool name and arguments object.');
    if (c.assertions !== undefined && !Array.isArray(c.assertions)) throw new Error('assertions must be an array.');
    if (c.comparePaths !== undefined && !Array.isArray(c.comparePaths)) throw new Error('comparePaths must be an array.');
    if (!(c.assertions?.length || c.comparePaths?.length)) throw new Error('Each case needs at least one assertion or comparePaths entry.');
    for (const a of c.assertions ?? []) {
      if (!object(a) || Object.keys(a).some(k => !['path', 'op', 'value'].includes(k)) || !['equals', 'exists', 'type'].includes(a.op))
        throw new Error('Assertions support only path, op (equals/exists/type), and value.');
      validatePointer(a.path);
      if (a.op !== 'exists' && !Object.hasOwn(a, 'value')) throw new Error('equals/type assertions require value.');
      if (a.op === 'exists' && Object.hasOwn(a, 'value')) throw new Error('exists assertions must omit value.');
      if (a.op === 'type' && !['null', 'array', 'object', 'string', 'boolean', 'number', 'integer'].includes(a.value))
        throw new Error('Unknown assertion value type.');
    }
    for (const path of c.comparePaths ?? []) validatePointer(path);
  }
  return input.cases;
}

function typeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return object(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}

function assertionFailures(result, assertions) {
  return assertions.flatMap(a => {
    const entry = atPointer(result, a.path);
    const pass = entry.exists && (a.op === 'exists' || (a.op === 'equals' ? isDeepStrictEqual(entry.value, a.value) : typeMatches(entry.value, a.value)));
    return pass ? [] : [{ path: a.path, check: a.op, reason: entry.exists ? 'assertion_failed' : 'path_missing' }];
  });
}

export function evaluateCase(c, before, after) {
  const result = { id: c.id, tool: c.tool, status: 'pass', before: before.status, after: after.status, failures: [] };
  if (before.status !== 'success') {
    return { ...result, status: 'inconclusive', reason: 'Baseline call did not succeed.' };
  }
  const oldFailures = assertionFailures(before.result, c.assertions ?? []);
  const missing = (c.comparePaths ?? []).filter(path => !atPointer(before.result, path).exists);
  if (oldFailures.length || missing.length) return {
    ...result, status: 'inconclusive', reason: 'Baseline does not satisfy the case; fix the fixture before attributing a failure to the upgrade.',
    failures: [...oldFailures, ...missing.map(path => ({ path, check: 'compare', reason: 'baseline_path_missing' }))],
  };
  if (after.status === 'transport_error' || after.status === 'not_run')
    return { ...result, status: 'inconclusive', reason: 'Candidate session failed; cause requires investigation.' };
  if (after.status === 'missing_tool')
    return { ...result, status: 'regression', reason: 'Baseline succeeded; candidate no longer advertises this tool. Candidate call was not attempted.' };
  if (after.status !== 'success')
    return { ...result, status: 'regression', reason: 'Baseline succeeded; candidate returned a tool or protocol error.' };
  result.failures = assertionFailures(after.result, c.assertions ?? []);
  for (const path of c.comparePaths ?? []) {
    const candidate = atPointer(after.result, path);
    if (!candidate.exists || !isDeepStrictEqual(atPointer(before.result, path).value, candidate.value))
      result.failures.push({ path, check: 'compare', reason: candidate.exists ? 'selected_value_changed' : 'path_missing' });
  }
  if (result.failures.length) { result.status = 'regression'; result.reason = 'Candidate violated an assertion or a declared stable-output comparison.'; }
  return result;
}

async function runVersion(config, cases, timeout, discovery) {
  const client = new StdioClient(config, timeout);
  const calls = [];
  try {
    const identity = await client.initialize();
    const tools = await client.listTools();
    compareCatalogs(tools, tools); // Validate catalogs before any tool call.
    const actions = discovery ? normalizeDiscovery(await discoverActions(client, tools, discovery), discovery) : undefined;
    const names = new Set(tools.map(t => t.name));
    for (const c of cases) {
      if (client.fatal) { calls.push({ status: 'not_run' }); continue; }
      if (!names.has(c.tool)) { calls.push({ status: 'missing_tool' }); continue; }
      try {
        const response = await client.request('tools/call', { name: c.tool, arguments: c.arguments });
        if (Object.hasOwn(response, 'error')) { calls.push({ status: 'protocol_error' }); continue; }
        const result = response.result;
        if (!object(result) || !Array.isArray(result.content) || (result.isError !== undefined && typeof result.isError !== 'boolean')) {
          calls.push({ status: 'protocol_error' }); continue;
        }
        calls.push({ status: result.isError ? 'tool_error' : 'success', result });
      } catch { calls.push({ status: 'transport_error' }); }
    }
    return { identity, tools, calls, actions, catalogChanges: client.catalogChanges };
  } finally { await client.close(); }
}

function makeReport(mode, before, after, findings, cases = []) {
  let verdict = 'no_detected_issues_in_checked_scope';
  if (findings.some(f => f.severity === 'review') || cases.some(c => c.status === 'inconclusive')) verdict = 'review_required';
  if (findings.some(f => f.severity === 'breaking')) verdict = 'contract_risk_detected';
  if (cases.some(c => c.status === 'regression')) verdict = 'regression_detected';
  return { formatVersion: 2, generatedAt: new Date().toISOString(), mode, verdict,
    toolCounts: { before: before.length, after: after.length }, findings, cases, limitations: LIMITATIONS };
}

function parseArgs(args) {
  const [mode, ...rest] = args;
  if (mode === '--help' || mode === '-h' || !mode) return { mode: 'help' };
  if (!['compare', 'compare-actions', 'discover', 'replay'].includes(mode)) throw new Error('Choose compare, compare-actions, discover, or replay.');
  const offline = mode === 'compare' || mode === 'compare-actions';
  const valid = new Set(offline ? ['before', 'after', 'out', ...(mode === 'compare-actions' ? ['discovery'] : [])]
    : ['before-config', 'after-config', 'out', 'timeout-ms', 'discovery', ...(mode === 'replay' ? ['cases', 'execute-cases'] : ['execute-discovery'])]);
  const options = { mode };
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i].startsWith('--') ? rest[i].slice(2) : '';
    if (!valid.has(key) || Object.hasOwn(options, key)) throw new Error('Unknown or duplicate command option.');
    if (key === 'execute-cases' || key === 'execute-discovery') options[key] = true;
    else {
      if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) throw new Error('Option is missing a value.');
      options[key] = rest[++i];
    }
  }
  const required = offline ? ['before', 'after', 'out'] : ['before-config', 'after-config', 'out', ...(mode === 'replay' ? ['cases'] : [])];
  if (mode === 'compare-actions' || mode === 'discover') required.push('discovery');
  if (required.some(k => !options[k])) throw new Error('Missing required option; run --help.');
  if (extname(options.out).toLowerCase() !== '.json') throw new Error('--out must end in .json. Markdown is written beside it.');
  const pathKey = p => process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
  const outputs = [pathKey(options.out), pathKey(options.out.slice(0, -5) + '.md')];
  if (['before','after','before-config','after-config','cases','discovery'].filter(k => options[k]).some(k => outputs.includes(pathKey(options[k])))) throw new Error('Output must not overwrite an input file.');
  const timeout = Number(options['timeout-ms'] ?? 10000);
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 300000) throw new Error('timeout-ms must be an integer from 100 to 300000.');
  options.timeout = timeout;
  return options;
}

export async function main(args) {
  const options = parseArgs(args);
  if (options.mode === 'help') {
    console.log('MCP Upgrade Check (Node.js 20+)\n\ncompare --before old.json --after new.json --out report.json\ncompare-actions --before old-capture.json --after new-capture.json --discovery discovery.json --out report.json\ndiscover --before-config old-server.json --after-config new-server.json --discovery discovery.json --out report.json --execute-discovery [--timeout-ms 10000]\nreplay --before-config old-server.json --after-config new-server.json --cases cases.json --out report.json --execute-cases [--discovery discovery.json] [--timeout-ms 10000]\n\nRuntime checks/setup: node scripts/runtime.mjs --help\nLive modes launch reviewed local executables; discovery calls only explicitly configured tools. Execution switches are gates, not a sandbox.\nExit codes: 0 no detected issues; 1 reproduced regression or contract risk; 2 invalid input/execution failure; 3 review or inconclusive.');
    return 0;
  }
  let report;
  if (options.mode === 'compare') {
    const before = extractCatalog(await readJSON(options.before));
    const after = extractCatalog(await readJSON(options.after));
    report = makeReport('compare', before, after, compareCatalogs(before, after));
    report.sources = { before: basename(options.before), after: basename(options.after) };
  } else if (options.mode === 'compare-actions') {
    const manifest = validateDiscoveryManifest(await readJSON(options.discovery));
    const before = normalizeDiscovery(await readJSON(options.before), manifest);
    const after = normalizeDiscovery(await readJSON(options.after), manifest);
    const { findings, ...discovery } = compareDiscovered(before, after);
    report = makeReport('compare-actions', [], [], findings);
    report.discovery = discovery;
    report.sources = { before: basename(options.before), after: basename(options.after), discovery: basename(options.discovery) };
  } else {
    const gate = options.mode === 'replay' ? 'execute-cases' : 'execute-discovery';
    if (!options[gate]) throw new Error(`Live check requires --${gate} after reviewing server commands and call side effects. No server was launched.`);
    const cases = options.cases ? validateCases(await readJSON(options.cases)) : [];
    const manifest = options.discovery ? validateDiscoveryManifest(await readJSON(options.discovery)) : undefined;
    // Validate both configurations before launching either server.
    const beforeConfig = await readServerConfig(options['before-config']);
    const afterConfig = await readServerConfig(options['after-config']);
    const before = await runVersion(beforeConfig, cases, options.timeout, manifest);
    const after = await runVersion(afterConfig, cases, options.timeout, manifest);
    const findings = compareCatalogs(before.tools, after.tools);
    let discovery;
    if (manifest) {
      const result = compareDiscovered(before.actions, after.actions);
      findings.push(...result.findings);
      const { findings: ignored, ...details } = result;
      discovery = details;
    }
    if (before.catalogChanges || after.catalogChanges) findings.push({ severity: 'review', code: 'catalog_changed_during_replay', tool: '*', path: '', message: 'Tool catalog changed during the session; the captured catalogs may not describe all calls.' });
    report = makeReport(options.mode, before.tools, after.tools, findings, cases.map((c, i) => evaluateCase(c, before.calls[i], after.calls[i])));
    if (discovery) report.discovery = discovery;
    report.protocolVersions = { before: before.identity.protocolVersion, after: after.identity.protocolVersion };
    report.servers = { before: before.identity.serverInfo, after: after.identity.serverInfo };
    report.sources = { before: basename(options['before-config']), after: basename(options['after-config']),
      ...(options.cases ? { cases: basename(options.cases) } : {}), ...(options.discovery ? { discovery: basename(options.discovery) } : {}) };
  }
  report.summary = summarizeFindings(report.findings);
  if (report.discovery) report.limitations = [...report.limitations,
    'Nested discovery is limited to the configured sources, backend, and completeness declarations. It does not execute discovered actions.',
    'Only mapped action names, descriptions, and input/output schemas are compared; other metadata such as execution mode and workflow hints requires separate review.'];
  await mkdir(dirname(resolve(options.out)), { recursive: true });
  await writeFile(options.out, JSON.stringify(report, null, 2) + '\n', 'utf8');
  await writeFile(options.out.slice(0, -5) + '.md', renderMarkdown(report), 'utf8');
  const counts = report.summary.severityCounts;
  console.log(`${report.verdict}: ${counts.breaking} contract risks, ${counts.review} review items (${report.summary.textOnlyMetadata.count} title/description changes grouped), ${counts.info} informational; ${report.cases.length} replay cases. Reports written.`);
  return report.verdict === 'no_detected_issues_in_checked_scope' ? 0 : report.verdict === 'review_required' ? 3 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    // Do not echo arbitrary server output or JSON parse snippets that could expose credentials.
    console.error(error instanceof SyntaxError ? 'Invalid JSON input.' : error.code ? `Input/output failure (${error.code}).` : error.message);
    process.exitCode = 2;
  });
}
