# Inputs, execution, and evidence

Use this reference when preparing snapshots or replay cases, reviewing launch configurations, or interpreting a report. All command examples run from the skill directory with Node.js 20 or newer. No package installation is needed.

## Saved tool catalogs

Each input is a JSON object containing a `tools` array, either at the top level or under `result`:

```json
{
  "tools": [
    {
      "name": "lookup_item",
      "description": "Look up an item in a test catalog.",
      "inputSchema": {
        "type": "object",
        "properties": { "id": { "type": "string" } },
        "required": ["id"]
      }
    }
  ]
}
```

Use full catalogs, not a first page. Inputs with a remaining `nextCursor` are rejected. Preserve the source fields; do not remove unfamiliar schema keywords to make a comparison pass.

For an `execute_action`/`search_actions` gateway, also use [nested discovery](discovery.md). Tool schemas can remain unchanged while the action contracts behind them change.

```sh
node scripts/check.mjs compare --before examples/baseline.json --after examples/candidate.json --out report.json
```

A catalog diff can expose removed tools and changed input/output contracts. It cannot prove that a caller actually breaks, establish compatibility for arbitrary JSON Schema, or detect behavior that is absent from the snapshots. Treat such findings as contract risks requiring targeted cases.

## Local server configurations

Provide one JSON configuration for each version:

```json
{
  "command": "node",
  "args": ["examples/mock-server.mjs", "baseline"],
  "cwd": "..",
  "env": { "APP_ENV": "test" }
}
```

This illustrates the format; use the supplied `examples/before-server.json` and `examples/after-server.json` for the runnable demo. `command` is an absolute executable path or a name resolvable through `PATH`. `args` is an array of strings. Optional `cwd` is resolved relative to the configuration file; set it explicitly when arguments contain relative file paths. Optional `env` adds literal, nonsecret string values to the inherited environment.

Keep credentials out of configuration files, case fixtures, and reports. Supply required credentials through the parent process environment. Review server output before sharing a report, because a server may return sensitive data even when the launch configuration contains none.

The CLI launches processes without a shell and hides Windows process windows. Use direct executables such as `node` or `python`; do not use `cmd`, shell command strings, or npm/npx wrapper commands. Resolve a package's actual executable entry point before configuring it.

Review both launch configurations as code execution. Confirm that the selected versions, working directories, environment, and fixtures match the requested check. The CLI cannot establish whether a tool is harmless from its name or annotations.

Use [runtime readiness and isolated setup](runtime.md) before rewriting launch code or mixing dependency versions. The runtime helper can diagnose a missing executable, wrong Python, absent modules, or initialization failure. It can generate isolated environments from explicit local packages, including packages supplied in separate source trees.

## Replay cases

Cases specify exactly which calls to make and which parts of the result matter:

```json
{
  "cases": [
    {
      "id": "known-item",
      "tool": "lookup_item",
      "arguments": { "id": "demo-1" },
      "assertions": [
        { "path": "/structuredContent/id", "op": "equals", "value": "demo-1" },
        { "path": "/structuredContent/name", "op": "exists" },
        { "path": "/structuredContent/name", "op": "type", "value": "string" }
      ],
      "comparePaths": ["/structuredContent/id", "/structuredContent/name"]
    }
  ]
}
```

Each case has a unique nonempty `id`, a `tool` name, and an `arguments` object. Supply at least one entry in `assertions` or `comparePaths`; either array may otherwise be omitted. Assertion paths and comparison paths are JSON Pointers into the tool result, for example `/structuredContent/id` or `/content/0/text`. Escape `~` as `~0` and `/` as `~1` inside a property-name segment.

- `equals` compares the selected value to `value`.
- `exists` requires the selected path to be present and has no `value` field.
- `type` checks the selected value against `value`: `string`, `number`, `integer`, `boolean`, `object`, `array`, or `null`.

Choose stable, meaningful paths. Do not compare timestamps, request identifiers, randomized text, or entire result objects merely because they are available. Empty comparison paths do not imply that outputs were equivalent; only the chosen assertions and other explicit checks provide evidence.

Obtain valid cases from known client requests or controlled fixtures. Establish expected results independently of the candidate version. A failing baseline assertion invalidates that case as evidence of a newly introduced regression.

## Running the replay

```sh
node scripts/check.mjs replay --before-config examples/before-server.json --after-config examples/after-server.json --cases examples/cases.json --out replay-report.json --execute-cases
```

The replay initializes each local stdio server, retrieves all tool-catalog pages, and executes each selected case once against each version. Tool-call execution requires `--execute-cases`. A case may therefore affect two separate environments, or the same backing environment twice if the configurations share it; account for that before execution.

Optional `--discovery discovery.json` runs the manifest's discovery requests before the cases in the same sessions. Discovery does not execute the advertised nested actions. To compare discovery alone, use `discover` with `--execute-discovery`; to inspect saved responses without launching anything, use `compare-actions`.

Use existing user authorization when it covers the exact actions. If a case would create, delete, publish, send, charge, or otherwise change real data beyond that authorization, prepare a controlled fixture or resolve the missing authorization first. A `readOnlyHint` declaration is advisory metadata, not proof or permission. Do not silently retry calls after failures or timeouts.

## Interpreting results

Use the generated Markdown for review and JSON for further processing. Both have the requested output basename. Keep observations distinct from inferred compatibility risks:

Markdown groups title/description changes and passing cases, while JSON preserves the full findings and per-case results. Defaults, constraints, unsupported schema changes, missing evidence, and failed/inconclusive cases remain detailed. This changes presentation, not verdicts: metadata-only differences can still require review because descriptions influence agent choices.

- A successful, valid baseline call followed by a candidate tool or protocol error is an observed regression for that case. A timeout or failed connection is inconclusive.
- If the candidate no longer advertises a requested tool, its call is not attempted. Report this as a catalog-discovery regression, not a reproduced tool-call error.
- A candidate assertion failure can establish a regression only when the baseline satisfies that assertion set.
- Differences at selected stable paths are observable changes; interpret them against the intended contract and disclose the selection.
- Catalog/schema differences remain static contract risks until appropriate runtime evidence establishes their effect.
- Baseline failures and unavailable evidence require review, not a claim that the candidate caused the problem.

One execution per version cannot separate random variation, transient services, and persistent changes. The runner does not test remote HTTP transport, authentication flows, subscriptions, task lifecycles, or all possible inputs. Report those limits when relevant to the user's upgrade decision.

The runner negotiates the 2025-11-25 protocol and accepts 2024-11-05, 2025-03-26, 2025-06-18, and 2025-11-25 responses. Other versions stop with an unsupported-version error. It advertises no client capabilities; sampling, roots, and elicitation requests are not supported. It follows at most 100 catalog pages and limits a buffered protocol message to 16 MiB. `--timeout-ms` sets a per-request timeout (default 10000); a timeout skips remaining calls for that server and terminates its process tree. This is a bounded test client, not a general MCP client.

Catalog finding paths address a normalized map keyed by tool name, such as `/tools/lookup_item/inputSchema`, rather than positions in the input array. Unsupported schema keyword changes require review. Output schemas are compared statically; replay does not automatically validate responses against full JSON Schema. Add assertions for the output guarantees that matter.

Exit codes: `0` means no detected issues within the checked scope, `1` means a contract risk or case regression, `2` means invalid input or a setup/execution failure, and `3` means review is required or a case is inconclusive. Reports are written only after both catalogs are obtained; inspect the exit status rather than trusting an older report left at the output path. A combined verdict can contain both regressions and inconclusive cases; inspect the individual cases.

Run the bundled regression tests with `node --test` from the skill directory. On Node.js 20.10 or newer, add `--test-concurrency=1` to reduce concurrent process startup during timeout tests. The bundled candidate intentionally fails three of four replay cases. The baseline against itself should pass all four.

Protocol references: [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), [lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), and [stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports). The implementation targets these protocol versions rather than assuming future revisions behave identically.
