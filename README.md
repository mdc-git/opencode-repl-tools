# OpenCode REPL Tools

OpenCode REPL Tools adds persistent Node.js/TypeScript and Python REPLs to OpenCode V2. Each OpenCode session can own at most one Node Cell and one Python Cell. A Cell keeps its interpreter alive across evaluations, preserves a bounded transcript across confirmed interpreter restarts, and accepts only one active job at a time.

The plugin runs trusted local code on Linux. It is not a sandbox.

## Browser demo

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/mdc-git/opencode-repl-tools?quickstart=1)

The Codespace is a trusted controller, not the public execution environment. It uses the host Docker daemon to start `ghcr.io/mdc-git/opencode-repl-tools-demo:demo` as a separate sandbox container and proxies only the sandbox terminal through forwarded port `7681`.

The sandbox image contains OpenCode V, Node 26, Python, `ttyd`, the plugin's production dependencies, the prewarmed Python REPL environment, and a root-owned read-only demo source snapshot. It does not contain GitHub CLI or the Codespaces publisher.

Every Codespace start pulls the demo image and resolves its local image ID for both the updater and public child. A serialized controller hook updates OpenCode with Bun in a disposable, credential-free container before launching the child. The updater creates the runtime in a fresh volume that the child mounts read-only. A separate updater-only volume caches package downloads, with fresh registry version resolution on every update. Cache retention is limited to 512 MiB at updater entry and exit; interrupted cleanup is handled on the next updater run.

The public sandbox receives no checkout bind mount, no Docker socket, and no GitHub or Codespaces credentials. It runs as UID/GID 1001 with a read-only root filesystem, all Linux capabilities dropped, `no_new_privs`, a private cgroup namespace, bounded CPU, memory, process count, file descriptors, and size-limited writable tmpfs mounts for its home and temporary directory. Docker's normal PID, mount, IPC, UTS, network, seccomp, and cgroup isolation remain in effect.

Up to four browser tabs or windows can attach to the same active OpenCode TUI through a shared `tmux` session. When the last browser disconnects, `ttyd` exits, the shared OpenCode process is retired, and the disposable OpenCode HOME and writable workspace are removed before the next connection cohort starts. Shared OpenCode binaries, Node dependencies, the source snapshot, and the prewarmed Python environment remain read-only.

OpenCode and the REPL workers start from a minimal explicit environment. The sandbox has outbound networking so users can connect an LLM provider, but provider credentials entered during an active public session are readable by code running as the same sandbox identity. Do not enter a valuable credential into a public demo session.

After the Codespace starts, the controller waits for the sandbox terminal, makes forwarded port `7681` public, verifies the port visibility, and opens:

```text
https://<codespace-name>-7681.app.github.dev/
```

Public-port availability depends on the repository or organization Codespaces policy. Anyone who can reach the URL controls the active public demo session.

Connect an LLM provider from the TUI with `/connect`, then ask OpenCode to use `repl_node` or `repl_python`.

If the browser terminal does not start, inspect the controller log and sandbox log:

```sh
cat "$HOME/.cache/opencode-repl-tools-preview.log"
docker logs opencode-repl-tools-demo-sandbox
```

The demo image is built by `.github/workflows/build-demo-image.yml`. CI builds and smoke-tests the exact sandbox launch policy before publishing the `:demo` tag, including the read-only filesystem, absent host mounts and Docker socket, non-root identity, capability and `no_new_privs` state, resource limits, and absence of GitHub credential variables.

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
jupyter_client=8.10.0
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

The repository uses Bun for local package management and commits `bun.lock`. Development tooling is consolidated under `tooling/`; `package.json` exposes two repository-level commands:

```sh
bun install --frozen-lockfile
bun run check
bun run fix
```

`bun run check` runs the repository validation gates without stopping at the first failure. `bun run fix` applies compatible direct-dependency updates and every available automatic cleanup, then reruns the full check against the resulting state. There is currently no project test runner or test suite, so the tooling setup does not invent one.

The dependency architecture enforced by ESLint reflects the current implementation: package entry → core/contracts; core → core/contracts/adapters; adapters → adapters/contracts/utils; contracts and utils are inward-only; worker code is isolated. Dependency Cruiser separately treats circular dependencies and deprecated Node core modules as errors and reports orphan modules as warnings.

The root package intentionally keeps `@opencode/plugin` at the literal `beta`. TypeScript is a runtime dependency because the Node worker transpiles snippets before evaluation.
