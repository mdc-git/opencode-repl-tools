# OpenCode REPL Tools

Persistent Node.js/TypeScript and Python REPL tools for OpenCode V2. Each OpenCode session owns at most one Node Cell and one Python Cell. A Cell keeps its interpreter alive across evaluations, preserves a bounded transcript across confirmed interpreter restarts, and accepts only one active job at a time.

This plugin is Linux-only and executes trusted local code. It is not a sandbox.

## Requirements

- OpenCode V2 with `@opencode/plugin` beta support.
- Node.js 26 or newer for `repl_node`.
- Python 3.10 or newer for `repl_python`.

The executable names are read once when the plugin activates:

```sh
export OPENCODE_REPL_NODE=node
export OPENCODE_REPL_PYTHON=python3
```

Both overrides are optional.

## Python environment

Python dependencies are bootstrapped automatically on first Python use. The environment is shared by the plugin activation and cached at:

```text
${XDG_CACHE_HOME:-$HOME/.cache}/opencode/repl-tools/python/<major.minor>/<requirements-sha>/venv
```

The current pinned requirements are:

```text
ipykernel==7.3.0
jupyter_client==8.10.0
```

Concurrent first users share one bootstrap. Cancelling one waiting REPL request does not cancel the shared bootstrap, while plugin unload does. Failed bootstraps are not cached. Bootstrap work is created under the operating system temporary directory instead of the persistent cache quota; pip is run with `--no-cache-dir --no-compile` to avoid download-cache and bytecode amplification.

## Tools

### `repl_node`

```json
{ "code": "globalThis.count = (globalThis.count ?? 0) + 1; count" }
```

Evaluates JavaScript or TypeScript in the current OpenCode session's persistent Node Cell. Each snippet is transpiled with `typescript.transpileModule` before evaluation, so annotations, interfaces, generics, enums, classes, and parameter properties are accepted while declarations and runtime state still persist between calls. This is transpilation only: semantic TypeScript type checking is not performed. `require` resolves from that session's location directory. Raw process stdout/stderr is recorded as ambient Cell output; structured REPL results and evaluation errors are attributed to the job.

### `repl_python`

```json
{ "code": "counter = globals().get('counter', 0) + 1\ncounter" }
```

Evaluates code in the current OpenCode session's persistent Jupyter-backed Python Cell. Jupyter parent message IDs are used for output attribution. Text display output is retained; binary rich media is not serialized.

### `repl_job`

Status, cancellation, and stdin use one session-local opaque job ID:

```json
{ "action": "status", "id": "<job-id>" }
```

```json
{ "action": "status", "id": "<job-id>", "cursor": 42 }
```

```json
{ "action": "cancel", "id": "<job-id>" }
```

```json
{ "action": "stdin", "id": "<job-id>", "data": "exact bytes as a string\n" }
```

`status` works for the active job and the 20 most recent terminal jobs in that language Cell. With no cursor it starts at the selected job's start cursor. With an explicit cursor it returns Cell transcript output after that cursor, including later jobs where applicable. A cursor older than retained transcript data returns the earliest retained data with `truncated: true`.

Cancellation is idempotent. An active job receives a cooperative interrupt first; after a fixed 2-second grace the interpreter is hard-retired if necessary. A hard teardown that cannot be confirmed leaves the Cell fail-closed and prevents replacement during the current plugin activation.

Python stdin is accepted only while that job is waiting for an input request. Node stdin is accepted while that job is active. The supplied data is sent exactly as provided: no newline is inserted, and stdin payloads are never recorded, echoed into the transcript by the plugin, logged, or included in synthetic notifications.

### `repl_reset`

```json
{ "language": "python" }
```

```json
{ "language": "node" }
```

Reset always targets one language. It hard-retires that Cell and invalidates its transcript and all retained job IDs. Reset is idempotent when no Cell exists. A failed teardown tombstone is cleared only if cleanup can subsequently be confirmed.

## Foreground and background execution

Every accepted evaluation starts in the foreground. The fixed 5-second foreground window begins when the job is accepted and includes interpreter startup and Python environment bootstrap.

If the job finishes within that window, the tool returns its terminal result. If Python requests input, or the job is still starting/running when the window expires, the job is handed to the activation-scoped background runtime and the tool returns its current handle/state.

Background terminal completion/failure and each distinct background Python input request use OpenCode V2 native synthetic session messages with resume enabled. Delivery is at-most-once. Explicit cancellation, reset, session invalidation, and plugin unload do not synthesize completion turns. `repl_job status` is the recovery path if a synthetic notification cannot be delivered.

## Retention

Each session-language Cell keeps:

- a 1 MiB UTF-8 transcript with monotonically increasing cursors;
- the 20 most recent terminal jobs;
- at most the newest 16 KiB of transcript-since-job-start in direct foreground and synthetic completion previews.

Automatic interpreter loss does not clear the Cell transcript or terminal history when cleanup is confirmed. Explicit reset, session move/delete/revert staging, or plugin unload invalidates the Cell.

## Plugin IDs

The package/default plugin ID is:

```text
github.opencode_repl_tools
```

This repository's `.opencode` checkout wrapper disables that deployed ID and re-exports the checkout under:

```text
local.opencode_repl_tools
```

## Development checks

The repository uses Bun for local package management and intentionally does not commit `bun.lock`. From the repository root, run each validation gate independently:

```sh
bun install
bun run format:check
bun run lint
bun run typecheck
bun run check:workers
bun run check:deps
bun run check:knip
bun run audit
bun pm pack
```

`bun run format` is the explicit mutating formatter command. There is currently no project test runner or test suite, so the tooling setup does not invent one.

The dependency architecture enforced by ESLint reflects the current implementation: package entry → core/contracts; core → core/contracts/adapters; adapters → adapters/contracts/utils; contracts and utils are inward-only; worker code is isolated. Dependency Cruiser separately treats circular dependencies and deprecated Node core modules as errors and reports orphan modules as warnings.

The root package intentionally keeps `@opencode/plugin` at the literal `beta` tag. TypeScript is a runtime dependency because the Node worker transpiles snippets before evaluation.
