# Public Codespaces demo architecture

This directory implements the public browser demo for OpenCode REPL Tools. Visitors can execute arbitrary code through OpenCode, so the GitHub Codespace is the trusted controller and the public TUI runs in a separate untrusted Docker container.

## Architecture

```text
GitHub Codespace

  trusted controller container
  ├─ root user
  ├─ host network
  ├─ host Docker socket
  ├─ GitHub/Codespaces authentication
  ├─ gh + Docker CLI
  ├─ postStart: start-demo-sandbox
  └─ postAttach: publish-demo
             │
             │ docker pull + updater + docker run
             ▼
  untrusted sandbox container
  ├─ uid/gid 1001
  ├─ read-only root filesystem
  ├─ no Linux capabilities
  ├─ no_new_privileges
  ├─ bridge network
  ├─ no bind mounts
  ├─ no Docker socket
  ├─ no GitHub credentials
  ├─ read-only OpenCode runtime volume
  └─ ttyd → tmux → run-demo-session
                         │
                         ▼
                    Bubblewrap
                    ├─ fresh mount, PID, IPC, UTS, cgroup, and user namespaces
                    ├─ shared outer network namespace
                    ├─ tmpfs root and OpenCode XDG state
                    ├─ read-only system/runtime assets
                    ├─ writable disposable workspace only
                    └─ OpenCode V2
             │
             │ 127.0.0.1:7681 on the Codespace host
             ▼
  GitHub Codespaces port forwarding
             │
             ▼
  public HTTPS browser URL
```

`devcontainer.json` selects the prebuilt controller image. The controller owns Docker and GitHub authority and starts the public child. The child publishes only port 7681 to host loopback; Codespaces provides the external HTTPS endpoint.

## Image and runtime model

The sandbox image contains:

- the OpenCode bootstrap executable and Bun runtime
- Bubblewrap
- ttyd and tmux
- Node.js and Python
- production plugin dependencies
- a read-only prebuilt Python REPL environment
- a source snapshot containing `.opencode`, the plugin source, package metadata, and documentation

At Codespace start, `start-demo-sandbox.sh` pulls the demo image, recreates the OpenCode runtime volume, and runs a disposable updater. The updater executes `opencode2 update --method bun`, verifies the resulting V2 executable, and exits. The public child mounts that runtime volume read-only.

The updater has a separate persistent Bun download-cache volume. Its HOME is disposable and the cache is not mounted into the public child.

## Public child hardening

`run-demo-sandbox.sh` creates the untrusted child with these controls:

- user `1001:1001`
- read-only root filesystem
- all Linux capabilities dropped
- `no-new-privileges`
- private cgroup namespace
- PID limit of 128
- memory limit of 2 GiB
- CPU limit of 2 CPUs
- file-descriptor limit of 256
- process limit of 128
- disabled core dumps
- 512 MiB executable tmpfs for `/home/opencode-demo`
- 64 MiB `noexec` tmpfs for `/tmp`
- Docker bridge networking
- host-loopback-only publication of port 7681
- no bind mounts
- no Docker socket
- no controller checkout
- no GitHub credentials
- read-only OpenCode runtime volume
- bounded local Docker logs

Docker's default seccomp and AppArmor profiles are disabled for this child because Bubblewrap must create namespaces and mount the filesystem view for the OpenCode process. The child still has no capabilities and retains `no-new-privileges`; OpenCode runs inside the nested Bubblewrap boundary described below.

The image strips SUID/SGID bits and removes world-writable permissions from its immutable filesystem content.

## Environment and credential isolation

The Docker socket and GitHub authentication exist only in the controller. They are never copied or mounted into the public child.

`run-demo-container.sh` starts from an `env -i` allowlist and launches ttyd through another minimal environment. `run-demo-session.sh` creates a new session home and workspace, copies the baked source snapshot into that workspace, links the immutable Node dependencies, and then invokes `opencode-ephemeral`.

The source checkout used by the controller is never mounted into the child.

## Ephemeral OpenCode sandbox

`opencode-ephemeral.sh` is the OpenCode launcher. It receives the disposable session workspace and creates a Bubblewrap sandbox with a tmpfs root.

The sandbox exposes only the runtime surfaces OpenCode needs:

- `/usr` and `/opt` read-only
- selected host/container system files read-only
- `/sys` read-only
- a fresh `/proc`
- a fresh `/dev`
- a writable tmpfs `/tmp`
- the current session workspace as the only writable project tree
- the prebuilt Python REPL cache read-only at the XDG cache path expected by the plugin

The launcher clears the environment and supplies an explicit runtime allowlist. OpenCode receives fresh per-process paths for:

```text
XDG_CONFIG_HOME=/tmp/opencode-xdg/config
XDG_DATA_HOME=/tmp/opencode-xdg/data
XDG_CACHE_HOME=/tmp/opencode-xdg/cache
XDG_STATE_HOME=/tmp/opencode-xdg/state
OPENCODE_CONFIG_DIR=/tmp/opencode-xdg/config/opencode
OPENCODE_DB=/tmp/opencode-xdg/data/opencode/opencode.db
NPM_CONFIG_CACHE=/tmp/opencode-xdg/npm
```

The plugin executable overrides are also explicit:

```text
OPENCODE_REPL_NODE=/usr/local/bin/node
OPENCODE_REPL_PYTHON=/usr/bin/python3
```

OpenCode starts from the disposable workspace with `--standalone`. Project configuration remains available through `$WORKSPACE/.opencode/opencode.jsonc`; its local plugin entry resolves to the copied `.opencode` plugin entrypoint and the bundled REPL plugin source.

No OpenCode database, cache, state, generated configuration, or session home survives the browser cohort.

## TUI and session lifecycle

The public terminal process tree is:

```text
run-demo-container
  └─ ttyd :7681
       └─ tmux session "opencode-demo"
            └─ run-demo-session
                 └─ opencode-ephemeral
                      └─ bwrap
                           └─ opencode2 --standalone <workspace>
```

`ttyd` is writable, checks request origin, allows at most four clients, and exits when the connection cohort is gone. tmux keeps the terminal stable while members of that cohort reconnect.

`run-demo-session.sh` takes an exclusive session lock, recreates `/home/opencode-demo/session`, populates a private writable workspace, and starts the Bubblewrap launcher. When ttyd exits, `run-demo-container.sh` kills the tmux server, removes the session tree, and starts a fresh ttyd cohort.

The enclosing `/home/opencode-demo` tmpfs lasts only for the lifetime of the public Docker child. The child itself is recreated whenever the Codespace start hook runs.

## Network model

The trusted controller uses host networking. The public child uses Docker bridge networking and publishes its HTTP listener only as `127.0.0.1:7681` on the Codespace host.

Bubblewrap shares the child's network namespace so OpenCode can use outbound connections subject to the surrounding platform's network policy. Bubblewrap does not receive the controller's host network namespace.

Codespaces forwards the loopback listener and provides the public HTTPS endpoint. `publish-demo.sh` makes the forwarded port public only after readiness succeeds and verifies the resulting visibility through `gh`.

## CI contract

`.github/workflows/build-demo-image.yml` validates the deployment architecture before publishing images.

The sandbox smoke test checks:

- OpenCode V2 seed availability
- Bubblewrap and the ephemeral launcher are installed
- a real `run-demo-session` remains alive
- a Bubblewrap process is present
- the OpenCode process receives the expected ephemeral XDG/database paths
- child UID and read-only rootfs
- resource limits and bridge networking
- private cgroup namespace
- dropped capabilities and `no-new-privileges`
- the seccomp/AppArmor settings required for nested Bubblewrap
- absence of bind mounts, Docker socket, controller checkout, and GitHub credentials
- read-only runtime, dependency, source, and Python-cache content
- absence of SUID/SGID and world-writable image content

Only after that smoke test passes is the demo image published. The controller image is built on top of the validated demo image and is then exercised through the Dev Container CLI, including the startup updater, loopback listener, child runtime volume, network model, security options, and current OpenCode executable.

## Security boundary and residual risk

The controller/public-child split protects the repository checkout, GitHub credentials, Docker authority, and controller filesystem from public visitor code. Bubblewrap additionally gives the OpenCode process a fresh filesystem and process namespace view with disposable application state.

The child and controller still share the Codespace host kernel. A successful kernel or container-runtime escape can cross the intended boundary. The controller's Docker socket is host-level authority and must remain exclusive to the trusted controller.

Outbound networking is intentionally available to OpenCode. Visitors in the same ttyd cohort share one tmux/OpenCode session and can observe and control the same terminal state. This demo is therefore a shared public session, not a private per-visitor environment.

## File map

- `devcontainer.json` selects the controller image, exposes the Docker socket to the controller, declares port 7681, and wires lifecycle hooks.
- `controller.Dockerfile` builds the trusted management image on top of the sandbox image.
- `Dockerfile` builds the public runtime, OpenCode bootstrap, Bubblewrap, plugin dependencies, Python cache, and source snapshot.
- `start-demo-sandbox.sh` updates and verifies OpenCode, recreates the child, and waits for readiness.
- `run-demo-sandbox.sh` defines the Docker security, resource, filesystem, network, and logging boundary.
- `run-demo-container.sh` sanitizes the child environment and supervises ttyd/tmux cohorts.
- `run-demo-session.sh` creates the disposable session home/workspace and invokes the ephemeral launcher.
- `opencode-ephemeral.sh` creates the Bubblewrap filesystem/namespace view and starts OpenCode with disposable XDG state.
- `publish-demo.sh` publishes and verifies the ready Codespaces port.
