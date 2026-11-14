# MCP Upgrade Check

Verdict: **contract\_risk\_detected**

A breaking static finding is a declared contract risk. A reproduced regression applies only to the supplied fixture and environment.

Mode: compare. Tools: 4 before, 3 after.

Baseline: baseline.json. Candidate: candidate.json.

## Contract findings

4 findings: 3 breaking contract risks, 0 review, 1 informational.

- **breaking** legacy\_status /tools/legacy\_status — Tool is no longer advertised; existing calls to this name may fail. (tool\_removed)
- **breaking** search\_items /tools/search\_items/inputSchema/properties/mode/enum — Input enum/const restricts permitted values. (allowed\_values\_changed)
- **breaking** search\_items /tools/search\_items/inputSchema/required — Property "limit" is now required; existing calls may omit it. (required\_added)
- **info** search\_items /tools/search\_items/inputSchema/properties/limit — Declared input property added. (property\_added)

## Replay cases

Behavioral replay was not performed.

## Coverage limits

- Static findings describe declared contract risks, not proven failures of every consumer.
- Schema analysis covers common keywords; it is not a complete JSON Schema subtype checker.
- Replay checks only the listed cases and assertions. No check proves an upgrade universally safe.
- No automatic output-schema validation, auth-flow, remote HTTP, subscription, task, or concurrent-session testing.

Raw arguments, return values, process commands, environment variables, and stderr are omitted from this report. Keep original case files private if they contain sensitive data.
