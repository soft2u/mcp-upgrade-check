# MCP Upgrade Check

Verdict: **regression\_detected**

A breaking static finding is a declared contract risk. A reproduced regression applies only to the supplied fixture and environment.

Mode: replay. Tools: 4 before, 3 after.

Baseline: before-server.json. Candidate: after-server.json.

Replay fixture: cases.json.

Server versions: upgrade-check-demo baseline → upgrade-check-demo candidate.

Negotiated protocols: 2025-11-25 → 2025-11-25.

## Catalog payload measurement

| Baseline bytes | Candidate bytes | Change |
| ---: | ---: | ---: |
| 810 | 762 | -48 (-5.93%) |

Measured as UTF-8 bytes of the compact JSON tools array, including advertised metadata and schemas. Excludes protocol envelopes, pagination, and host-specific formatting. This is not a token count, latency measurement, or proof of task efficiency.

Largest increases per tool: search\_items (+38 bytes).

## Contract findings

4 findings: 3 breaking contract risks, 0 review, 1 informational.

- **breaking** legacy\_status /tools/legacy\_status — Tool is no longer advertised; existing calls to this name may fail. (tool\_removed)
- **breaking** search\_items /tools/search\_items/inputSchema/properties/mode/enum — Input enum/const restricts permitted values. (allowed\_values\_changed)
- **breaking** search\_items /tools/search\_items/inputSchema/required — Property "limit" is now required; existing calls may omit it. (required\_added)
- **info** search\_items /tools/search\_items/inputSchema/properties/limit — Declared input property added. (property\_added)

## Replay cases

4 cases: **1 passed, 3 regressions, 0 inconclusive**.

Passed case IDs: unchanged-health-check.
All specified checks passed for these cases, including any explicitly expected tool errors. Per-case tool names and statuses remain in the JSON report.

- **regression** price-keeps-major-currency-units (lookup\_item): Baseline satisfied the case; candidate violated its expected response status or assertions. Baseline: success; candidate: success.
  Declared checks — baseline: **pass**; candidate: **fail**. Expected response: success.
  - Candidate /structuredContent/price: equals / assertion\_failed
- **regression** existing-search-request (search\_items): Baseline satisfied the case; candidate violated its expected response status or assertions. Baseline: success; candidate: tool\_error.
  Declared checks — baseline: **pass**; candidate: **fail**. Expected response: success.
  - Candidate : status / unexpected\_response\_status
- **regression** legacy-client-status (legacy\_status): Baseline satisfied the case; candidate no longer advertises this tool. Candidate call was not attempted. Baseline: success; candidate: missing\_tool.
  Declared checks — baseline: **pass**; candidate: **unavailable**. Expected response: success.

## Coverage limits

- Static findings describe declared contract risks, not proven failures of every consumer.
- Schema analysis covers common keywords; it is not a complete JSON Schema subtype checker.
- Replay checks only the listed cases and assertions. No check proves an upgrade universally safe.
- No automatic output-schema validation, auth-flow, remote HTTP, subscription, task, or concurrent-session testing.

Raw arguments, return values, process commands, environment variables, and stderr are omitted from this report. Keep original case files private if they contain sensitive data.
