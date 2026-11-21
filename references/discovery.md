# Nested action discovery

Some servers expose only `search_actions` and `execute_action` in `tools/list`. Their useful contracts are nested in a discovery tool's response. Comparing the two dispatcher schemas alone does not check those action names or parameters.

Use an explicit discovery manifest to identify the tools to call and how to read their results. Discovery calls run only the listed discovery tools; they do not invoke the discovered actions. A configured discovery tool can still have side effects, so inspect its implementation or documentation and reuse the user's actual authorization. A `readOnlyHint` is not a substitute for that review.

## Manifest

Start from `examples/discovery.json`. This example describes a common search/execute interface, not every server and not the bundled demo server. Set the actual names from `tools/list`, including any gateway prefix. Each source has:

- `id`: stable component identity, unique in the manifest.
- `discoveryTool` and `executionTool`: exact MCP tool names. The latter qualifies action identities; discovery never calls it.
- `arguments`: explicit arguments for the discovery call.
- `actionsPath`: JSON Pointer from the MCP tool result to its action array.
- `fields`: property names within each action for `name`, and optionally `description`, `inputSchema`, and `outputSchema`. Optional `metadata` maps stable labels to other descriptor property names. These are literal property names, not JSON Pointers. No schema is synthesized when a field is absent.
- Optional `successPath`: JSON Pointer to an application-level success indicator. Its expected scalar `successValue` defaults to `true`. This handles servers that return `{success:false}` inside an otherwise successful MCP response.
- `completeness`: the evidence and adapter contract for whether the response covers every action.

Pointers address the unwrapped tool result, such as `/structuredContent/result/actions`. They do not include the outer JSON-RPC `result` wrapper. Property names in pointers escape `~` as `~0` and `/` as `~1`.

Read the discovery tool's description and implementation before selecting arguments. Some interfaces return names and descriptions by default and require a documented detail flag to include parameter schemas. For example, a server may offer `detailed: true`. Configure that flag explicitly when supported; the runner does not guess flags or treat missing schemas as permanently unavailable.

## Completeness and false removals

`allActionsRequested: true` is an explicit statement that the query requests the entire relevant action inventory. A narrow search cannot establish whole-component removals, even if it returns fewer items than its limit.

Choose a mode only when the server's documented behavior supports it:

- `unknown`: default. No completeness is assumed.
- `unpaginated`: the adapter declares that this unfiltered call returns the whole list.
- `limit`: the adapter declares that the server honors `limit` and returning fewer items exhausts the list. Set the same positive `limit` in this section and the actual call arguments. An undocumented server-side cap invalidates this assumption; use `unknown` instead.

Optional `totalPath`, `nextCursorPath`, and `truncatedPath` point to explicit completeness signals in the result. A matching reported total or a configured truncation flag of `false` can establish completeness. A remaining cursor, `true` truncation flag, inconsistent total, or missing configured total/truncation field prevents it. Reaching a limit is incomplete unless a separate explicit signal establishes that all results were returned. The runner does not automatically follow discovery cursors or combine pages. Use a reviewed adapter/capture that supplies the full inventory, or retain partial coverage.

Live capture also checks that both the discovery tool and parent execution tool are advertised. A missing discovery tool yields unavailable coverage. A missing execution tool allows inventory capture but prevents a complete coverage claim.

An action is qualified by the source id, parent execution tool, and action name. Each segment is URI-encoded and joined with `::`, so two components with an action named `status` remain distinct. Duplicate names within the same qualified source are rejected instead of silently overwritten.

## CLI workflows

Run from the skill directory. Use the final CLI help to confirm installed options.

```sh
node scripts/check.mjs compare-actions --before old-actions.json --after new-actions.json --discovery examples/discovery.json --out actions-report.json
```

Offline captures map source ids (preferred) or exact discovery-tool names to JSON-RPC responses, raw MCP tool results, or `{ "status": "success", "result": <MCP tool result> }` entries. Existing captures such as `{ "component_search_actions": { "jsonrpc": "2.0", "id": 1, "result": { ... } } }` work with a matching manifest. If several sources use the same discovery tool, capture by unique source id to prevent ambiguity.

```sh
node scripts/check.mjs discover --before-config old-server.json --after-config new-server.json --discovery examples/discovery.json --out actions-report.json --execute-discovery
```

To collect nested actions in the same sessions as selected replay cases:

```sh
node scripts/check.mjs replay --before-config old-server.json --after-config new-server.json --cases cases.json --discovery examples/discovery.json --out replay-report.json --execute-cases
```

Discovery requests use the existing request timeout and are not silently retried. A failed call or missing capture is coverage uncertainty, not an empty complete action inventory. The report retains names, schema availability, counts, and coverage reasons; raw discovery arguments, responses, and schema bodies are not placed in its inventory.

## Interpreting results

Complete candidate discovery can establish that a previously observed action is no longer advertised. This is a static contract risk, not proof that an action call failed. An action missing from a partial candidate response is only unobserved; the report does not call it removed. Likewise, an action seen only after an incomplete baseline is newly observed, not necessarily newly added.

Missing input schemas require review and remain absent in normalization. Output schemas are compared when both are available, even if an input schema is missing. Output-schema availability is recorded for every action; optional output schemas absent on both sides are not fabricated or treated as removals. Supported schema differences use the same directional analysis as tool catalogs. The comparison does not execute the actions or prove behavior compatibility.

Map additional action metadata explicitly when it matters to the upgrade:

```json
"fields": {
  "name": "name",
  "inputSchema": "input_schema",
  "metadata": {
    "execution_mode": "execution_mode",
    "read_only": "readOnly",
    "workflow_hints": "workflow_hints"
  }
}
```

Changes, additions, and removals of these mapped fields produce review findings. For example, an execution mode changing from offline to live requires review even with identical action schemas. A missing field is distinct from a present `null`; object key order is ignored and array order is preserved. Findings identify the action and field but omit raw metadata values. Inventory entries record field mapping and presence; internal normalized captures retain values for comparison and should be treated as source data.

Unmapped action fields remain outside the comparison. Mapped metadata changes are observations requiring review, not proof that an action's behavior changed. For historical captures whose request arguments are unknown, use `arguments: {}` as a required offline placeholder and leave completeness unknown; this is not evidence that the original call used empty arguments.

Library integration: `validateDiscoveryManifest(input)`, `discoverActions(client, tools, manifest)`, `normalizeDiscovery(capture, manifest)`, and `compareDiscovered(before, after)`. The client needs `request(method, params)` and may expose `fatal`. The comparison returns `{findings, counts, coverage, inventory}`; callers can merge findings with their tool-catalog findings and store the remaining fields as `report.discovery`.
