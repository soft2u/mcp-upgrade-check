# MCP Upgrade Check

Compare MCP server versions before upgrading: inspect tool and nested-action contracts, replay selected calls, and produce evidence you can review.

This repository contains an agent skill and standalone Node.js command-line tools. It is an early public beta. The comparison tools have no third-party JavaScript dependencies.

## What it checks

- **Tool catalogs:** removed tools, changed input/output schemas, and metadata changes.
- **Nested actions:** explicitly configured discovery tools, qualified action names, available schemas, and incomplete discovery coverage.
- **Behavioral replay:** assertions and selected stable result paths, once against each local stdio server version.
- **Runtime readiness:** executable paths, optional Python imports, and optional MCP initialization/tool-list checks.
- **Isolated Python setup:** copied local packages, separate virtual environments, dependency pins, source hashes, and generated launch configurations.

Markdown reports group title/description changes and passing cases. JSON retains every finding and case result. Missing schemas and incomplete inventories remain visible.

## Requirements and installation

Use Node.js 20 or newer for the CLI. Python and `uv` are needed only for Python runtime preparation; replay needs whatever runtime the selected server requires.

Download or clone the repository and run the examples from its root. No `npm install` is needed.

To use the agent skill, copy the complete folder into your agent's skills directory, keeping `SKILL.md`, `scripts/`, and `references/` together. In the standard Codex user layout, the destination is `~/.codex/skills/mcp-upgrade-check/`. Start with a request such as:

> Use $mcp-upgrade-check to compare these two MCP server versions. Check their tool catalogs and nested actions, then replay the supplied local test cases.

## Try the included demo

Compare two saved catalogs without starting a server:

```sh
node scripts/check.mjs compare --before examples/baseline.json --after examples/candidate.json --out work/catalog.json
```

The candidate intentionally contains breaking changes, so this command writes its reports and exits with code **1**. See the committed [example catalog report](reports/catalog.md).

Replay four cases against the included local mock servers:

```sh
node scripts/check.mjs replay --before-config examples/before-server.json --after-config examples/after-server.json --cases examples/cases.json --out work/replay.json --execute-cases
```

This deliberately reproduces three regressions and one passing case. It exits with code **1**. The mock servers make no external connections. See the [example replay report](reports/replay.md).

For a passing control, use `examples/before-server.json` for both configurations. All four cases should pass with exit code **0**; the example output is [unchanged.md](reports/unchanged.md).

## Compare your own versions

Provide one stdio launch configuration per version and explicit cases for the behavior you want to preserve. Review the commands and tool side effects before running them. `--execute-cases` and `--execute-discovery` are execution gates, not sandboxes.

| Workflow | Guide |
| --- | --- |
| Saved catalogs, server configurations, replay cases, and verdicts | [Inputs and evidence](references/workflow.md) |
| Action discovery behind dispatcher tools | [Nested action discovery](references/discovery.md) |
| Existing-runtime checks and isolated Python setup | [Runtime preparation](references/runtime.md) |
| Agent instructions | [SKILL.md](SKILL.md) |

For servers that expose actions through discovery tools, add `--discovery discovery.json` to replay. The manifest maps exact discovery tools and descriptor fields; the runner does not guess harmless calls or execute the actions it discovers. The discovery and runtime manifests under `examples/` describe hypothetical servers and need adaptation.

Use `node scripts/check.mjs --help` and `node scripts/runtime.mjs --help` for all commands.

## Interpreting reports

| Exit | Meaning |
| --- | --- |
| `0` | No issue detected within the checked scope |
| `1` | Static contract risk or an observed replay regression |
| `2` | Invalid input or a setup/execution failure |
| `3` | Review needed or inconclusive evidence |

The runtime helper documents its separate readiness statuses in [runtime.md](references/runtime.md). A filesystem-only check does not prove that the server can start.

A clean comparison is evidence for the supplied catalogs, fixtures, and environment. It does not certify every caller or deployment. The schema comparator covers common keywords rather than arbitrary JSON Schema semantics. Replay does not automatically validate results against full output schemas. HTTP transports, authentication flows, subscriptions, tasks, and live hardware workflows are outside the current scope. Configuration-dependent behavior may require a separate controlled probe.

Reports omit raw arguments, response bodies, environment values, and server logs. Keep sensitive launch configurations and fixtures outside the public repository.

## Development and contributions

Run the regression suite from the repository root (Node.js 20.10+ for the concurrency option):

```sh
node --test --test-concurrency=1
```

The tests cover schema direction, incomplete discovery, missing schemas, execution gates, selected-result comparisons, timeouts, process cleanup, report grouping, and runtime setup boundaries. Runtime preparation unit tests use a simulated installer; they do not demonstrate real dependency installation on every platform. Symlink tests may skip where the operating system does not grant the required privileges.

Issue reports and pull requests are welcome. Include a minimal synthetic catalog/case, the command used, and your Node.js/operating-system versions. Do not include credentials, proprietary server packages, or private runtime data. For behavior fixes, include a regression case that fails before the change.

## License

Copyright (c) 2026 Vasile Nechifor. Released under the [MIT License](LICENSE).
