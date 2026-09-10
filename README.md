# OpenCode REPL Tools

OpenCode REPL Tools adds persistent Node.js/TypeScript and Python REPLs to OpenCode V2. Each OpenCode session can own at most one Node Cell and one Python Cell. A Cell keeps its interpreter alive across evaluations, preserves a bounded transcript across confirmed interpreter restarts, and accepts only one active job at a time.

The plugin runs trusted local code on Linux. It is not a sandbox.

## Browser demo

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/mdc-git/opencode-repl-tools/tree/demo?quickstart=1)

The `demo` branch launches from `ghcr.io/mdc-git/opencode-repl-tools-demo:demo`. The image already contains Node 26, OpenCode V2, `ttyd`, GitHub CLI, the plugin's production Node dependencies, and the Python REPL environment. Codespace startup performs no package installation or tool downloads.

The browser TUI runs as the dedicated `opencode-demo` Unix user. The container first snapshots the repository into a root-owned read-only source tree, then removes access by the demo identity to the real `/workspaces` checkout. Root lifecycle commands execute image-owned scripts rather than files from the mutable checkout.

Each browser connection receives a fresh OpenCode HOME and writable workspace copied from the immutable source snapshot. The prior connection's OpenCode state, provider auth files, logs, and workspace mutations are removed before the next connection starts. Shared OpenCode binaries, Node dependencies, and the prewarmed Python environment are root-owned and read-only. `ttyd` accepts one client at a time and checks the WebSocket origin.

OpenCode and the REPL workers start from a minimal explicit environment and do not inherit the normal Codespaces environment, including `GITHUB_TOKEN` or Codespaces secrets.

After the Codespace starts, the image-owned publisher waits for `ttyd`, makes forwarded port `7681` public, verifies the port visibility, and opens:

```text
https://<codespace-name>-7681.app.github.dev/
```

Public-port availability depends on the repository or organization Codespaces policy. The public terminal intentionally permits arbitrary code execution as `opencode-demo`; anyone who can reach the URL controls the active demo session. Do not enter a valuable provider credential into a public demo session. A credential connected during the active session is readable by code running as the same Unix identity even though it is removed before the next browser session starts.

Connect an LLM provider from the TUI with `/connect`, then ask OpenCode to use `repl_node` or `repl_python`.

If the browser terminal does not start, inspect:

```sh
cat "$HOME/.cache/opencode-repl-tools-preview.log"
```

The demo image is built by `.github/workflows/build-demo-image.yml`. BuildKit cache keeps its independent toolchain and dependency stages reusable. The image smoke test also verifies that the public demo identity cannot read the real source checkout or modify the shared runtime. A Codespaces prebuild can additionally snapshot the ready image for the `demo` branch if minimum cold-start latency is required.

## Requirements

- OpenCode V2 with `@opencode/plugin` beta support.
- Node.js 26 or newer for `repl_node`.
- Python 3.10 or newer for `repl_python`.

The plugin reads the executable names once when it activates. Set either override before activation if needed:

```sh
export OPENCODE_REPL_NODE=node
export OPENCODE_REPL_PYTHON=python3
```

Both variables are optional.

## Python environment

On first Python use, the plugin bootstraps a shared virtual environment automatically and caches it at:

```text
${XDG_CACHE_HOME:-$HOME/.cache}/opencode/repl-tools/python/<major.minor>/<requirements-sha>/venv
```

The current pinned requirements are:

```text
ipykernel==7.3.0
jupyter_client==8.10.0
```

Concurrent first users share the same bootstrap. Cancelling one waiting REPL request does not cancel that shared work, but unloading the plugin does. Failed bootstraps are not cached.

Bootstrap work is created under the operating system temporary directory rather than inside the persistent cache quota. Pip runs with `--no-cache-dir --no-compile` to avoid download-cache and bytecode amplification.

## Tools

### `repl_node`

```json
{ "code": "globalThis.count = (globalThis.count ?? 0) + 1; count" }
```

Evaluates JavaScript or TypeScript in the current OpenCode session's persistent Node Cell. The plugin transpiles each snippet with `typescript.transpileModule` before evaluation, so annotations, interfaces, generics, enums, classes, and parameter properties are accepted while declarations and runtime state persist between calls.

This is transpilation only. Semantic TypeScript type checking is not performed. `require` resolves from the session's location directory. Raw process stdout and stderr are recorded as ambient Cell output, while structured REPL results and evaluation errors are attributed to the job.

The Node Cell exposes `opencode.emitImage({ bytes, mimeType, filename? })` for in-memory image output. `bytes` accepts a `Buffer`, `Uint8Array`, `ArrayBuffer`, or another array-buffer view. PNG, JPEG, WebP, and GIF are supported. Each evaluation may emit up to four images of at most 5 MiB each. Emitted images are returned directly as tool content and do not require filesystem output.

```js
await opencode.emitImage({
  bytes: imageBuffer,
  mimeType: 'image/png',
  filename: 'preview.png'
})
```

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

`status` works for the active job and the 20 most recent terminal jobs in that language Cell. Without a cursor, output starts at the selected job's start cursor. With an explicit cursor, it returns Cell transcript output after that cursor, including output from later jobs where applicable. If the cursor is older than the retained transcript, the response starts at the earliest retained data and sets `truncated: true`.

Cancellation is idempotent. An active job first receives a cooperative interrupt. If it is still active after a fixed 2-second grace period, the interpreter is hard-retired. If a hard teardown cannot be confirmed, the Cell fails closed and cannot be replaced during the current plugin activation.

Python stdin is accepted only while that job is waiting for an input request. Node stdin is accepted while that job is active. The supplied data is sent exactly as provided: no newline is inserted, and the plugin never records stdin payloads, echoes them into the transcript, logs them, or includes them in synthetic notifications.

### `repl_reset`

```json
{ "language": "python" }
```

```json
{ "language": "node" }
```

Reset always applies to one language. It hard-retires that Cell and invalidates its transcript and all retained job IDs. Reset is idempotent when no Cell exists. A failed teardown tombstone is cleared only if cleanup can later be confirmed.

## Foreground and background execution

Every accepted evaluation starts in the foreground. The fixed 5-second foreground window starts when the job is accepted and includes interpreter startup and Python environment bootstrap.

If the job finishes within that window, the tool returns its terminal result. If Python requests input, or the job is still starting or running when the window expires, the activation-scoped background runtime takes ownership and the tool returns the job's current handle and state.

Background terminal completion or failure, plus each distinct background Python input request, uses OpenCode V2 native synthetic session messages with resume enabled. Delivery is at-most-once. Explicit cancellation, reset, session invalidation, and plugin unload do not synthesize completion turns. If a synthetic notification cannot be delivered, `repl_job status` is the recovery path.

## Retention

Each session-language Cell keeps:

- a 1 MiB UTF-8 transcript with monotonically increasing cursors;
- the 20 most recent terminal jobs;
- at most the newest 16 KiB of transcript-since-job-start in direct foreground and synthetic completion previews.

Automatic interpreter loss does not clear the Cell transcript or terminal history when cleanup is confirmed. Explicit reset, session move/delete/revert staging, or plugin unload invalidates the Cell.

## Plugin IDs

The package's default plugin ID is:

```text
github.opencode_repl_tools
```

This repository's `.opencode` checkout wrapper disables that deployed ID and re-exports the checkout as:

```text
local.opencode_repl_tools
```

## Development checks

The repository uses Bun for local package management and intentionally does not commit `bun.lock`. Run each validation gate independently from the repository root:

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
