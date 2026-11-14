---
name: mcp-upgrade-check
description: Compare MCP server tools and nested action catalogs, prepare isolated test runtimes, and replay selected local stdio calls before an upgrade. Use to investigate removed tools/actions, schema changes, or observable behavior regressions between versions; not for general MCP installation or production safety certification.
---

# MCP Upgrade Check

Produce evidence about changes between a known baseline and a candidate MCP server version. Use the bundled zero-dependency CLI with Node.js 20 or newer. Run commands from this skill's directory.

## Choose the check

- **Catalog comparison:** Use existing catalog JSON files. This reads local files and does not launch servers or call their tools.
- **Local replay:** Use reviewed stdio server launch configurations and explicit test cases. This launches both versions and calls each selected tool once per version.
- **Nested actions:** When tools dispatch named actions, use an explicit discovery manifest to compare the action inventory and available schemas. Read [references/discovery.md](references/discovery.md); a stable `tools/list` does not establish that nested actions stayed compatible.
- **Runtime readiness:** For source packages or launch failures, read [references/runtime.md](references/runtime.md). Check an existing runtime first; prepare isolated Python runtimes only when needed. A missing dependency or blocked loopback connection is a setup problem until evidence attributes it to the upgrade.

Start with the supplied artifacts. Identify which version is the baseline and what behavior the user needs to preserve. Do not invent test inputs, stable outputs, or expected results when those choices could affect real data. Read [references/workflow.md](references/workflow.md) for input formats, execution boundaries, and interpretation.

## Compare saved catalogs

```sh
node scripts/check.mjs compare --before examples/baseline.json --after examples/candidate.json --out report.json
```

Replace the example paths with the user's snapshots. Accepted inputs contain `tools` directly or in a JSON-RPC/Inspector `result.tools` envelope. A snapshot with a remaining `nextCursor` is incomplete and must be completed before comparison.

## Replay selected cases

Review the launch commands, directories, environment additions, case arguments, assertions, and selected comparison paths before execution. A server process is executable code; a tool's `readOnlyHint` annotation does not grant permission to run it. Reuse authorization already established in the conversation. If that authorization does not cover a launch or tool action, resolve it before executing the dependent operation. A broad upgrade-check request does not authorize mutations in production.

Use the bundled local example servers to try the workflow:

```sh
node scripts/check.mjs replay --before-config examples/before-server.json --after-config examples/after-server.json --cases examples/cases.json --out replay-report.json --execute-cases
```

For real servers, use isolated test data and the user's authorized environment. The explicit `--execute-cases` switch is required for tool-call execution. Do not silently add cases, retry state-changing calls, or expand the scope to live accounts.

Add `--discovery discovery.json` to replay to collect configured action catalogs in the same sessions. Discovery calls only the manifest's discovery tools, never the actions they describe. For discovery without behavioral cases:

```sh
node scripts/check.mjs discover --before-config before-server.json --after-config after-server.json --discovery discovery.json --out discovery-report.json --execute-discovery
```

Use `compare-actions --before old-capture.json --after new-capture.json --discovery discovery.json --out actions-report.json` for saved discovery responses. Do not assert removals from a partial search or invent schemas for descriptors that omit them. Dynamic actions are limited to the configured backend and environment.

## Deliver the result

Comparison and replay commands write JSON and a Markdown report with the same basename, such as `report.json` and `report.md`. Markdown groups title/description changes and passing cases; JSON retains every finding and case. Grouping does not change severity or the verdict. Defaults, constraints, unsupported schema changes, and coverage gaps remain visible.

Separate:

- **Confirmed regressions:** Observed failures against a valid baseline in the executed cases.
- **Static contract risks:** Catalog or schema changes that may break callers, without proving a runtime failure.
- **Review items:** Unverified effects, invalid baselines, and checks outside the evidence available.

Explain the affected tools or cases, the evidence, and the next useful check. State the scope actually tested. A clean report supports only that scope; it does not establish that the upgrade is safe for every caller or environment.

These checks cover saved catalogs, configured nested discovery, and local stdio request/response replay. They do not test HTTP transports, authentication flows, subscriptions, tasks, or infer stability from repeated runs. A configuration-specific behavior defect may require a separate controlled probe; a catalog diff alone cannot expose it.
