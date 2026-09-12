# OpenCode REPL Tools

Persistent Node.js/TypeScript and Python REPLs for OpenCode V2.

The plugin gives OpenCode long-lived Node and Python interpreters, so variables,
imports, and other state survive between tool calls.

> The plugin runs trusted local code on Linux. It is not a sandbox.

## Features

- Persistent Node.js/TypeScript and Python sessions
- Background execution for long-running code
- Job status, cancellation, and stdin
- Explicit REPL reset
- Direct image output from Node
- Per-session isolation

## Requirements

- Linux
- OpenCode V2
- Node.js 26+
- Python 3.10+

## Install

Add the plugin to your OpenCode configuration:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-repl-tools@git+https://github.com/mdc-git/opencode-repl-tools.git"
    }
  ]
}
```

Optional executable overrides:

```sh
export OPENCODE_REPL_NODE=node
export OPENCODE_REPL_PYTHON=python3
```

## Quick start

Once loaded, OpenCode gets four tools:

- `repl_node`
- `repl_python`
- `repl_job`
- `repl_reset`

### Node

```json
{ "code": "globalThis.count = (globalThis.count ?? 0) + 1; count" }
```

Run another evaluation in the same OpenCode session:

```json
{ "code": "count += 1; count" }
```

State is preserved between calls.

TypeScript syntax is supported and transpiled before evaluation.

### Python

```json
{ "code": "counter = globals().get('counter', 0) + 1\ncounter" }
```

Then:

```json
{ "code": "counter += 1\ncounter" }
```

The same Python interpreter stays alive between evaluations.

## Background jobs

Evaluations begin in the foreground. Long-running work automatically becomes a
background job.

Check its status:

```json
{ "action": "status", "id": "<job-id>" }
```

Cancel it:

```json
{ "action": "cancel", "id": "<job-id>" }
```

Send stdin:

```json
{ "action": "stdin", "id": "<job-id>", "data": "hello\n" }
```

## Reset a REPL

Reset Python:

```json
{ "language": "python" }
```

Reset Node:

```json
{ "language": "node" }
```

Resetting clears that interpreter and its retained state.

## Node image output

Node code can emit images directly:

```js
await opencode.emitImage({
  bytes: imageBuffer,
  mimeType: "image/png"
})
```

PNG, JPEG, WebP, and GIF are supported.

## Browser demo

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/mdc-git/opencode-repl-tools?quickstart=1)

The demo runs inside an isolated Docker sandbox and uses OpenCode's configured
free default models. No credentials are required.

After it starts, ask OpenCode to use `repl_node` or `repl_python`.

> **Do not enter API keys, tokens, passwords, or other valuable credentials into
> the public demo session.**

## Development

Install dependencies:

```sh
bun install --frozen-lockfile
```

Run repository checks:

```sh
bun run check
```

Apply supported fixes and rerun validation:

```sh
bun run fix
```
