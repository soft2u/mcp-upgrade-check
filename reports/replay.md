# MCP Upgrade Check

Verdict: **regression\_detected**

A breaking static finding is a declared contract risk. A reproduced regression applies only to the supplied fixture and environment.

Mode: replay. Tools: 4 before, 3 after.

Baseline: before-server.json. Candidate: after-server.json.

Replay fixture: cases.json.

Server versions: upgrade-check-demo baseline → upgrade-check-demo candidate.

Negotiated protocols: 2025-11-25 → 2025-11-25.

## Contract findings

4 findings: 3 breaking contract risks, 0 review, 1 informational.

- **breaking** legacy\_status /tools/legacy\_status — Tool is no longer advertised; existing calls to this name may fail. (tool\_removed)
- **breaking** search\_items /tools/search\_items/inputSchema/properties/mode/enum — Input enum/const restricts permitted values. (allowed\_values\_changed)
- **breaking** search\_items /tools/search\_items/inputSchema/required — Property "limit" is now required; existing calls may omit it. (required\_added)
- **info** search\_items /tools/search\_items/inputSchema/properties/limit — Declared input property added. (property\_added)

## Replay cases

4 cases: **1 passed, 3 regressions, 0 inconclusive**.

Passed case IDs: unchanged-health-check.
All specified checks passed for these cases. Per-case tool names and statuses remain in the JSON report.

- **regression** price-keeps-major-currency-units (lookup\_item): Candidate violated an assertion or a declared stable-output comparison. Baseline: success; candidate: success.
  - /structuredContent/price: equals / assertion\_failed
- **regression** existing-search-request (search\_items): Baseline succeeded; candidate returned a tool or protocol error. Baseline: success; candidate: tool\_error.
- **regression** legacy-client-status (legacy\_status): Baseline succeeded; candidate no longer advertises this tool. Candidate call was not attempted. Baseline: success; candidate: missing\_tool.

## Coverage limits

- Static findings describe declared contract risks, not proven failures of every consumer.
- Schema analysis covers common keywords; it is not a complete JSON Schema subtype checker.
- Replay checks only the listed cases and assertions. No check proves an upgrade universally safe.
- No automatic output-schema validation, auth-flow, remote HTTP, subscription, task, or concurrent-session testing.

Raw arguments, return values, process commands, environment variables, and stderr are omitted from this report. Keep original case files private if they contain sensitive data.
