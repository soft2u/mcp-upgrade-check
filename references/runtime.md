# Runtime readiness and isolated Python preparation

Use this workflow when a server cannot launch, a virtual environment points at an absent interpreter, two releases need different dependency versions, or a separately distributed shared/core package is missing. Run commands from the skill directory. The helper needs Node.js 20+; Python preparation additionally needs an existing Python interpreter and `uv`.

## Diagnose before calling tools

```sh
node scripts/runtime.mjs doctor --config server.json --out readiness.json
```

The default only checks the working directory and direct executable. It does not execute the server, interpreter, or imports. `launch_not_tested` means the filesystem prerequisites passed, not that the server is ready. With `--out`, full details go to the JSON file and the console shows a short status line.

For a reviewed Python configuration, explicitly test the interpreter and relevant imports:

```sh
node scripts/runtime.mjs doctor --config server.json --python --imports fastmcp,jsonschema,yaml --timeout-ms 30000 --out readiness.json
```

This executes the configured executable as Python in isolated mode, reports Python version/architecture and installed distribution versions for the requested modules, and detects import failures. Importing a module can execute code. Do not point `--python` at an unrelated executable or infer that successful imports prove protocol compatibility. Credentials, server arguments, raw stdout/stderr, and environment values are omitted from the report.

Once startup side effects are understood and authorized, add `--smoke`:

```sh
node scripts/runtime.mjs doctor --config server.json --python --imports fastmcp --smoke --timeout-ms 45000 --out readiness.json
```

Smoke launches the server, initializes MCP, follows tool-list pagination, validates catalog shape, and stops the process. It makes no `tools/call` requests. The timeout bounds the entire smoke session, not each page independently. A server may still discover installations, create local files, start helper processes, or contact services during initialization; a smoke switch is not a sandbox or authorization for those effects.

If construction succeeds but stdio initialization stalls, inspect startup/event-loop and environment restrictions before changing application code. In particular, a local listener can exist while a sandbox blocks the child process from reaching it. Do not label a timeout or permission error a confirmed upgrade regression. Resolve the environment condition and rerun the same bounded check.

## Prepare one isolated environment per release

Copy [the example manifest](../examples/runtime.json), then replace its illustrative interpreter, source paths, module, pins, and runtime destination. The example refers to a hypothetical repository and is not a runnable demo.

```sh
node scripts/runtime.mjs prepare --manifest my-runtime.json
node scripts/runtime.mjs prepare --manifest my-runtime.json --apply
```

The first command produces a plan without creating files or launching processes. The second copies source and executes package build/install steps. Use existing authorization when it covers the reviewed local sources, dependency downloads, and isolated setup. It never launches the MCP server or changes a global Python environment.

Manifest fields:

| Field | Meaning |
| --- | --- |
| `formatVersion` | Must be `1`. |
| `runtimeDir` | Fresh destination, resolved relative to the manifest. Existing destinations are refused, even if empty. |
| `python` | Existing interpreter executable or PATH name. An explicit full path avoids Windows Store aliases and stale venv base paths. |
| `uv` | Optional direct executable, default `uv`. Shell wrappers are unsupported. |
| `packages` | Nonempty `{ "name": "unique-folder", "path": "local/package" }` entries. Paths are manifest-relative. Include every separately distributed local dependency. |
| `requirements` | Optional exact `name==version` pins. Ranges, URLs, shell options, markers, and wildcard pins are rejected. |
| `lockFile` | Optional manifest-relative file of exact pins, one per line; comments and blanks allowed. Use the previous run's generated lock for repeatable external dependency versions. |
| `server.module` | Dotted module launched through the isolated interpreter's `-m` option. |
| `server.args` | Optional arguments after the module. Relative paths are interpreted from the runtime directory; use explicit paths for reviewed server configs. |
| `server.env` | Optional nonsecret environment additions. Credentials should remain in the invoking process environment. Values are written only to the generated private server config, not the plan/report. |
| `timeoutMs` | Bound for each setup process, default 180000; range 1000–900000. |

Preparation copies package source into `runtimeDir/source/<name>`, creates `runtimeDir/venv`, and uses an explicit `runtimeDir/cache`. It skips existing venvs, Git metadata, Python caches, node modules, credential directories, `.env*`, and old egg metadata. Symbolic links/junctions are refused so build actions cannot silently write through them to the originals. Source and destination must not contain one another. Review excluded files if the package needs one for building; materialize a suitable source checkout instead of disabling isolation.

`uv` runs without project configuration and with the public PyPI default index. The helper does not download another interpreter, reuse installed packages from another Python ABI, or switch indexes on failure. Build backends execute copied source code and can have their own side effects; source copying and a venv are not an OS sandbox. Transitive dependencies resolve normally unless pinned by the manifest/lock. A first unlocked run is recorded, not claimed to be bit-for-bit reproducible across future dates or platforms.

Successful output includes:

- `server.json`, ready for `doctor`, capture, and replay.
- `requirements.lock.txt`, exact external dependency versions, excluding editable local packages.
- `source-hashes.json`, SHA-256 hashes of the copied source files before builds.
- `setup-status.json`, the completion state.

Check the result with `doctor --python` and the needed imports before starting smoke or replay. If installation fails, the helper retains partial files and a classified stage error. It neither deletes the directory nor retries mutating setup automatically; inspect it, correct the manifest, and use a fresh destination. Raw dependency logs are not saved. For unavailable proprietary/local dependencies, provide their explicit source directory rather than substituting a different release's site-packages.

Exit codes: `0` plan/check completed without a detected failure; `2` invalid input or setup failure; `3` missing prerequisites/readiness failure. A default doctor exit `0` still means launch was not tested.
