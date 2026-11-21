# MCP Upgrade Check

Verdict: **review\_required**

A breaking static finding is a declared contract risk. A reproduced regression applies only to the supplied fixture and environment.

Mode: replay. Tools: 2 before, 2 after.

Baseline: policy-before-server.json. Candidate: policy-after-server.json.

Replay fixture: policy-cases.json.

Server versions: policy-demo baseline → policy-demo candidate.

Negotiated protocols: 2025-11-25 → 2025-11-25.

## Catalog payload measurement

| Baseline bytes | Candidate bytes | Change |
| ---: | ---: | ---: |
| 287 | 287 | 0 (0.00%) |

Measured as UTF-8 bytes of the compact JSON tools array, including advertised metadata and schemas. Excludes protocol envelopes, pagination, and host-specific formatting. This is not a token count, latency measurement, or proof of task efficiency.

## Contract findings

0 findings: 0 breaking contract risks, 0 review, 0 informational.

No differences detected by the supported checks.

## Replay cases

2 cases: **1 passed, 0 regressions, 1 inconclusive**.

Passed case IDs: write-is-correctly-refused.
All specified checks passed for these cases, including any explicitly expected tool errors. Per-case tool names and statuses remain in the JSON report.

- **inconclusive** offline-policy (policy\_status): Baseline does not satisfy the case; review the fixture and both observations before attributing a failure to the upgrade. Baseline: success; candidate: success.
  Declared checks — baseline: **fail**; candidate: **pass**. Expected response: success.
  - Baseline /structuredContent/liveDiscoveryEnabled: equals / assertion\_failed

## Coverage limits

- Static findings describe declared contract risks, not proven failures of every consumer.
- Schema analysis covers common keywords; it is not a complete JSON Schema subtype checker.
- Replay checks only the listed cases and assertions. No check proves an upgrade universally safe.
- No automatic output-schema validation, auth-flow, remote HTTP, subscription, task, or concurrent-session testing.

Raw arguments, return values, process commands, environment variables, and stderr are omitted from this report. Keep original case files private if they contain sensitive data.
