# MCP Upgrade Check

Verdict: **no\_detected\_issues\_in\_checked\_scope**

A breaking static finding is a declared contract risk. A reproduced regression applies only to the supplied fixture and environment.

Mode: replay. Tools: 4 before, 4 after.

Baseline: before-server.json. Candidate: before-server.json.

Replay fixture: cases.json.

Server versions: upgrade-check-demo baseline → upgrade-check-demo baseline.

Negotiated protocols: 2025-11-25 → 2025-11-25.

## Contract findings

0 findings: 0 breaking contract risks, 0 review, 0 informational.

No differences detected by the supported checks.

## Replay cases

4 cases: **4 passed, 0 regressions, 0 inconclusive**.

Passed case IDs: price-keeps-major-currency-units, existing-search-request, legacy-client-status, unchanged-health-check.
All specified checks passed for these cases. Per-case tool names and statuses remain in the JSON report.


## Coverage limits

- Static findings describe declared contract risks, not proven failures of every consumer.
- Schema analysis covers common keywords; it is not a complete JSON Schema subtype checker.
- Replay checks only the listed cases and assertions. No check proves an upgrade universally safe.
- No automatic output-schema validation, auth-flow, remote HTTP, subscription, task, or concurrent-session testing.

Raw arguments, return values, process commands, environment variables, and stderr are omitted from this report. Keep original case files private if they contain sensitive data.
