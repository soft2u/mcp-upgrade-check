/** Pure presentation helpers. JSON findings and verdicts are never rewritten. */

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const severityCounts = () => ({ breaking: 0, review: 0, info: 0, other: 0 });
const countSeverity = (counts, severity) => counts[Object.hasOwn(counts, severity) ? severity : 'other']++;
const escape = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ')
  .replace(/([\\`*_{}\[\]<>|])/g, '\\$1');

function pointerParts(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || /~(?:[^01]|$)/.test(path)) return null;
  return path.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function schemaAnnotationPath(parts) {
  if (!['inputSchema', 'outputSchema'].includes(parts[2])) return false;
  // Walk schema locations, not literal values in enum/default/examples. A property
  // named "description" is not itself a description annotation.
  for (let index = 3; index < parts.length - 1;) {
    const key = parts[index++];
    if (['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'].includes(key)) {
      if (index >= parts.length - 1) return false;
      index++;
    } else if (['allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(key)) {
      if (index >= parts.length - 1 || !/^(0|[1-9][0-9]*)$/.test(parts[index++])) return false;
    } else if (!['items', 'additionalProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else'].includes(key)) {
      return false;
    }
  }
  return true;
}

function textMetadataKind(finding) {
  // Never suppress a breaking finding, an unknown severity, or schema uncertainty.
  if (!['review', 'info'].includes(finding.severity)) return null;
  const parts = pointerParts(finding.path);
  if (!parts || parts[0] !== 'tools' || parts[1] !== finding.tool) return null;
  const kind = parts.at(-1);
  if (!['title', 'description'].includes(kind)) return null;
  if (finding.code === 'tool_metadata_changed' && parts.length === 3) return kind;
  if (finding.code === 'schema_annotation_changed' && schemaAnnotationPath(parts)) return kind;
  return null;
}

/**
 * Partition findings for presentation without changing their order, objects,
 * severities, or the input array. All original findings remain in report JSON.
 *
 * Returns { total, severityCounts, detailedFindings, textOnlyMetadata: {
 *   count, titleCount, descriptionCount, tools, severityCounts
 * } }. Counts use breaking/review/info/other; tools is a sorted unique name list.
 */
export function summarizeFindings(findings) {
  if (!Array.isArray(findings) || findings.some(finding => !object(finding))) {
    throw new TypeError('findings must be an array of finding objects.');
  }
  const counts = severityCounts();
  const metadataCounts = severityCounts();
  const detailedFindings = [];
  const tools = new Set();
  let titleCount = 0, descriptionCount = 0;
  for (const finding of findings) {
    countSeverity(counts, finding.severity);
    const kind = textMetadataKind(finding);
    if (!kind) { detailedFindings.push(finding); continue; }
    countSeverity(metadataCounts, finding.severity);
    tools.add(finding.tool);
    if (kind === 'title') titleCount++;
    else descriptionCount++;
  }
  return {
    total: findings.length,
    severityCounts: counts,
    detailedFindings,
    textOnlyMetadata: {
      count: titleCount + descriptionCount,
      titleCount, descriptionCount, tools: [...tools].sort(), severityCounts: metadataCounts,
    },
  };
}

function countText(counts) {
  return `${counts.breaking} breaking contract risks, ${counts.review} review, ${counts.info} informational`
    + (counts.other ? `, ${counts.other} other` : '');
}

const count = value => Number.isInteger(value) && value >= 0 ? String(value) : 'unknown';

function discoveryLines(discovery) {
  const counts = discovery.counts ?? {};
  const lines = ['## Discovered action coverage', '',
    `Actions: ${count(counts.before)} before, ${count(counts.after)} after. These are discovered actions, not additional MCP tools.`, '',
    `Input schemas available: ${count(counts.beforeWithInputSchema)}/${count(counts.before)} before; ${count(counts.afterWithInputSchema)}/${count(counts.after)} after.`, ''];
  const missingBefore = Number.isInteger(counts.before) && Number.isInteger(counts.beforeWithInputSchema)
    ? counts.before - counts.beforeWithInputSchema : null;
  const missingAfter = Number.isInteger(counts.after) && Number.isInteger(counts.afterWithInputSchema)
    ? counts.after - counts.afterWithInputSchema : null;
  if (missingBefore > 0 || missingAfter > 0) {
    lines.push(`Missing input schemas: **${count(missingBefore)} before, ${count(missingAfter)} after**. Those actions cannot receive a complete input-contract comparison.`, '');
  }
  const coverage = discovery.coverage ?? [];
  const inventory = discovery.inventory ?? [];
  const metadataLabels = [...new Set(inventory.flatMap(entry => Object.keys(entry.metadataFields ?? {})))].sort();
  if (metadataLabels.length) lines.push(
    `Explicitly mapped action metadata: ${metadataLabels.map(escape).join(', ')}. Field mappings and presence are recorded in JSON; values are omitted.`, '');
  if (coverage.length) {
    lines.push('| Source / execution tool | Baseline | Candidate | Input schemas before → after |',
      '| --- | --- | --- | --- |');
    for (const source of coverage) {
      const entries = inventory.filter(entry => entry.sourceId === source.sourceId && entry.executionTool === source.executionTool);
      const available = side => entries.filter(entry => entry[side]?.present && entry[side]?.inputSchema === 'present').length;
      const state = side => `${count(source[side]?.actionCount)} actions; ${escape(source[side]?.status ?? 'unknown')}`;
      const schemaCoverage = side => inventory.length
        ? `${available(side)}/${count(source[side]?.actionCount)}` : `unknown/${count(source[side]?.actionCount)}`;
      lines.push(`| ${escape(source.sourceId)} / ${escape(source.executionTool)} | ${state('before')} | ${state('after')} | ${schemaCoverage('before')} → ${schemaCoverage('after')} |`);
    }
    lines.push('');
    for (const source of coverage) {
      for (const side of ['before', 'after']) {
        const state = source[side];
        if (state?.status === 'complete') continue;
        const reasons = state?.reasons?.length ? state.reasons.map(escape).join(', ') : 'No completion evidence supplied.';
        lines.push(`- **${escape(state?.status ?? 'unknown')}** ${escape(source.sourceId)} / ${escape(source.executionTool)} (${side}): ${reasons}`);
      }
    }
    lines.push('');
  } else {
    lines.push('No per-source completion evidence was supplied; action counts alone do not establish complete discovery.', '');
  }
  return lines;
}

function caseLines(cases) {
  const lines = ['## Replay cases', ''];
  if (!cases.length) return [...lines, 'Behavioral replay was not performed.', ''];
  const counts = { pass: 0, regression: 0, inconclusive: 0, other: 0 };
  for (const entry of cases) counts[Object.hasOwn(counts, entry.status) ? entry.status : 'other']++;
  lines.push(`${cases.length} cases: **${counts.pass} passed, ${counts.regression} regressions, ${counts.inconclusive} inconclusive**${counts.other ? `, ${counts.other} other` : ''}.`, '');
  const compactPass = entry => entry.status === 'pass' && entry.before === (entry.expectedStatus ?? 'success')
    && entry.after === (entry.expectedStatus ?? 'success') && !entry.failures?.length && !entry.reason;
  const passed = cases.filter(compactPass);
  if (passed.length) lines.push(`Passed case IDs: ${passed.map(entry => escape(entry.id)).join(', ')}.`,
    'All specified checks passed for these cases, including any explicitly expected tool errors. Per-case tool names and statuses remain in the JSON report.', '');
  for (const entry of cases.filter(entry => !compactPass(entry))) {
    lines.push(`- **${escape(entry.status)}** ${escape(entry.id)} (${escape(entry.tool)}): ${escape(entry.reason ?? (entry.status === 'pass' ? 'All specified checks passed.' : 'No reason supplied.'))} Baseline: ${escape(entry.before)}; candidate: ${escape(entry.after)}.`);
    const shownFailures = new Set();
    if (entry.checks) {
      lines.push(`  Declared checks — baseline: **${escape(entry.checks.before?.status ?? 'unavailable')}**; candidate: **${escape(entry.checks.after?.status ?? 'unavailable')}**. Expected response: ${escape(entry.expectedStatus ?? 'success')}.`);
      for (const side of ['before', 'after']) {
        for (const failure of entry.checks[side]?.failures ?? []) {
          shownFailures.add(JSON.stringify(failure));
          lines.push(`  - ${side === 'before' ? 'Baseline' : 'Candidate'} ${escape(failure.path)}: ${escape(failure.check)} / ${escape(failure.reason)}`);
        }
      }
    }
    for (const failure of entry.failures ?? []) {
      if (!shownFailures.has(JSON.stringify(failure)))
        lines.push(`  - ${escape(failure.path)}: ${escape(failure.check)} / ${escape(failure.reason)}`);
    }
  }
  lines.push('');
  return lines;
}

function metricLines(metrics) {
  const payload = metrics?.catalogPayload;
  if (!payload) return [];
  const delta = Number.isFinite(payload.deltaBytes) ? `${payload.deltaBytes > 0 ? '+' : ''}${payload.deltaBytes}` : 'unknown';
  const percent = Number.isFinite(payload.deltaPercent) ? ` (${payload.deltaPercent > 0 ? '+' : ''}${payload.deltaPercent.toFixed(2)}%)` : '';
  const lines = ['## Catalog payload measurement', '',
    '| Baseline bytes | Candidate bytes | Change |', '| ---: | ---: | ---: |',
    `| ${count(payload.beforeBytes)} | ${count(payload.afterBytes)} | ${delta}${percent} |`, '',
    'Measured as UTF-8 bytes of the compact JSON tools array, including advertised metadata and schemas. Excludes protocol envelopes, pagination, and host-specific formatting. This is not a token count, latency measurement, or proof of task efficiency.', ''];
  if (payload.largestIncreases?.length) {
    lines.push('Largest increases per tool: ' + payload.largestIncreases.map(item => `${escape(item.tool)} (+${count(item.deltaBytes)} bytes)`).join(', ') + '.', '');
  }
  return lines;
}

/** Render the existing report shape plus optional discovery:{counts,coverage,inventory}. */
export function renderMarkdown(report) {
  const summary = summarizeFindings(report.findings ?? []);
  const cases = report.cases ?? [];
  const lines = ['# MCP Upgrade Check', '', `Verdict: **${escape(report.verdict)}**`, '',
    'A breaking static finding is a declared contract risk. A reproduced regression applies only to the supplied fixture and environment.', ''];
  if (report.mode === 'compare-actions') lines.push('Mode: action-only comparison. MCP tool catalogs were not compared.', '');
  else lines.push(`Mode: ${escape(report.mode)}. Tools: ${count(report.toolCounts?.before)} before, ${count(report.toolCounts?.after)} after.`, '');
  if (report.sources) {
    lines.push(`Baseline: ${escape(report.sources.before)}. Candidate: ${escape(report.sources.after)}.`, '');
    if (report.sources.cases) lines.push(`Replay fixture: ${escape(report.sources.cases)}.`, '');
  }
  if (report.servers) lines.push(`Server versions: ${escape(report.servers.before?.name)} ${escape(report.servers.before?.version)} → ${escape(report.servers.after?.name)} ${escape(report.servers.after?.version)}.`, '');
  if (report.protocolVersions) lines.push(`Negotiated protocols: ${escape(report.protocolVersions.before)} → ${escape(report.protocolVersions.after)}.`, '');
  if (report.discovery) lines.push(...discoveryLines(report.discovery));
  if (report.mode !== 'compare-actions') lines.push(...metricLines(report.metrics));

  lines.push('## Contract findings', '', `${summary.total} findings: ${countText(summary.severityCounts)}.`, '');
  if (!summary.total) lines.push('No differences detected by the supported checks.', '');
  else if (!summary.detailedFindings.length) lines.push('All detected differences are title/description metadata changes summarized below.', '');
  const priority = { breaking: 0, review: 1, info: 2 };
  for (const finding of [...summary.detailedFindings].sort((a, b) => (priority[a.severity] ?? 1) - (priority[b.severity] ?? 1))) {
    lines.push(`- **${escape(finding.severity)}** ${escape(finding.tool)} ${escape(finding.path)} — ${escape(finding.message)} (${escape(finding.code)})`);
  }
  if (summary.detailedFindings.length) lines.push('');
  const metadata = summary.textOnlyMetadata;
  if (metadata.count) {
    lines.push(`Title/description metadata: **${metadata.count} findings summarized** (${metadata.titleCount} title, ${metadata.descriptionCount} description) across ${metadata.tools.length} tools/actions.`,
      `Original severities retained: ${countText(metadata.severityCounts)}. These text changes can affect agent selection or behavior; grouping them does not establish compatibility or change the verdict.`,
      'All individual findings, paths, and messages remain in the JSON report.', '');
  }
  lines.push(...caseLines(cases));
  lines.push('## Coverage limits', '', ...(report.limitations ?? []).map(limit => `- ${escape(limit)}`), '',
    'Raw arguments, return values, process commands, environment variables, and stderr are omitted from this report. Keep original case files private if they contain sensitive data.', '');
  return lines.join('\n');
}
