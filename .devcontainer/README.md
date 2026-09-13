# Public Codespaces demo architecture

This directory implements the public browser demo for OpenCode REPL Tools. The GitHub Codespace is the trusted controller. Visitor-controlled terminal processes run only inside a nested Bubblewrap sandbox in a separate Docker child.

## Architecture

```text
GitHub Codespace

  trusted controller container
  ├─ host network
  ├─ Docker socket
  ├─ GitHub/Codespaces authentication
  └─ start-demo-sandbox
             │
             ▼
  Docker child: trusted sandbox supervisor
  ├─ uid 0
  ├─ read-only root filesystem
  ├─ capabilities: SYS_ADMIN only
  ├─ no_new_privileges
  ├─ private cgroup namespace
  ├─ bridge network
  ├─ no host bind mounts
  ├─ no Docker socket
  ├─ no GitHub credentials
  └─ run-demo-container
             │
             ▼
  Bubblewrap security boundary
  ├─ fresh mount, PID, IPC, UTS, and cgroup namespaces
  ├─ shared Docker-child network namespace
  ├─ tmpfs root and writable /tmp
  ├─ uid/gid 1001
  ├─ no Linux capabilities
  ├─ no_new_privileges
  ├─ disposable home and OpenCode XDG state
  ├─ disposable writable /workspace
  ├─ read-only system/runtime assets
  └─ ttyd → tmux → OpenCode V2
             │
             ▼
  127.0.0.1:7681 → GitHub Codespaces port forwarding
```

The controller owns Docker and GitHub authority. The Docker child has only the authority required to construct the Bubblewrap boundary; it does not expose a shell or terminal before the privilege drop. The public HTTP terminal, tmux server, OpenCode process, plugin code, and visitor commands all run as uid/gid 1001 with an empty capability set inside Bubblewrap.

## Image and runtime model

The demo image contains the OpenCode bootstrap executable, Bun, Bubblewrap 0.12.0, ttyd, tmux, Node.js, Python, production plugin dependencies, a read-only prebuilt Python REPL environment, and a source snapshot containing `.opencode` and the plugin source.

Bubblewrap 0.12.0 is built from its pinned upstream release tarball with the published SHA-256. The runtime does not use a setuid Bubblewrap executable.

At Codespace start, `start-demo-sandbox.sh` pulls the demo image, recreates the OpenCode runtime volume, and runs a disposable updater. The updater executes `opencode2 update --method bun`, verifies the resulting V2 executable, and exits. The Docker child mounts that runtime volume read-only. A separate Bun download-cache volume is available only to the updater.

## Docker child

`run-demo-sandbox.sh` starts the child with:

- uid/gid `0:0` for the trusted supervisor
- read-only root filesystem
- all capabilities dropped, then only `SYS_ADMIN` added
- `no-new-privileges`
- private cgroup namespace
- PID limit 128
- memory limit 2 GiB
- CPU limit 2 CPUs
- file-descriptor limit 256
- process limit 128
- disabled core dumps
- bounded tmpfs storage for `/home/opencode-demo` and `/tmp`
- Docker bridge networking
- port 7681 published only to host loopback
- no bind mounts
- no Docker socket
- no controller checkout
- no GitHub credentials
- read-only OpenCode runtime volume
- bounded local Docker logs

Docker's default seccomp and AppArmor profiles are disabled because the trusted supervisor must create the Bubblewrap mount and process namespaces. Visitor-controlled processes never run with the supervisor's `SYS_ADMIN` capability.

The image strips SUID/SGID bits and removes world-writable permissions from immutable image content.

## Session lifecycle

`run-demo-container.sh` starts from a sanitized environment. For each browser cohort it recreates `/home/opencode-demo/session`, copies the baked source snapshot into a fresh workspace owned by uid 1001, links the immutable Node dependencies, and invokes `opencode-ephemeral`.

The public process tree is:

```text
run-demo-container        trusted root supervisor
  └─ opencode-ephemeral   trusted Bubblewrap setup
       └─ bwrap
            └─ setpriv uid=1001 gid=1001 caps=none
                 └─ ttyd :7681
                      └─ tmux session "opencode-demo"
                           └─ opencode2 --standalone /workspace
```

When ttyd exits, the Bubblewrap sandbox ends, the supervisor deletes the cohort workspace, and a fresh cohort is created.

## Ephemeral OpenCode state

`opencode-ephemeral.sh` receives the disposable host-side workspace and exposes it inside the sandbox as `/workspace`. The checked-in `/workspace/.opencode/opencode.jsonc` remains the project configuration and its local `"./"` plugin entry resolves to the copied `.opencode` entrypoint and bundled REPL plugin source.

The launcher creates a fresh private home and fresh OpenCode state for every Bubblewrap invocation:

```text
XDG_CONFIG_HOME=/tmp/opencode-xdg/config
XDG_DATA_HOME=/tmp/opencode-xdg/data
XDG_CACHE_HOME=/tmp/opencode-xdg/cache
XDG_STATE_HOME=/tmp/opencode-xdg/state
OPENCODE_CONFIG_DIR=/tmp/opencode-xdg/config/opencode
OPENCODE_DB=/tmp/opencode-xdg/data/opencode/opencode.db
NPM_CONFIG_CACHE=/tmp/opencode-xdg/npm
```

The prebuilt Python REPL cache is mounted read-only at the cache path expected by the plugin. Node and Python executable overrides are explicit. No OpenCode database, cache, state, generated configuration, or home directory survives the cohort.

## Network model

The controller uses host networking. The Docker child uses bridge networking and publishes `127.0.0.1:7681` on the Codespace host. Bubblewrap shares only the Docker child's network namespace, so OpenCode can make outbound requests without receiving the controller's host network namespace.

Codespaces forwards the loopback listener and provides the public HTTPS endpoint. `publish-demo.sh` makes the forwarded port public only after readiness succeeds and verifies its visibility through `gh`.

## CI contract

`.github/workflows/build-demo-image.yml` validates the deployment boundary before publishing images. The sandbox smoke test requires:

- OpenCode V2 seed availability
- exactly Bubblewrap 0.12.0
- successful execution of a command as uid 1001 through `opencode-ephemeral`
- a real OpenCode TUI process inside Bubblewrap
- expected ephemeral XDG/database environment paths
- uid 1001 and zero inheritable, permitted, effective, bounding, and ambient capabilities for public processes
- root supervisor with only `SYS_ADMIN`
- read-only rootfs and runtime volume
- resource limits, bridge networking, and private cgroup namespace
- required Docker seccomp/AppArmor settings
- absence of host binds, Docker socket, controller checkout, and GitHub credentials
- read-only source, dependencies, and Python cache
- absence of SUID/SGID and world-writable immutable image content

Only after the sandbox passes is the demo image published. The controller image is then built from that validated image and exercised through the Dev Container CLI, including the startup updater and end-to-end listener.

## Security boundary and residual risk

The controller/public-child split protects the repository checkout, GitHub credentials, Docker authority, and controller filesystem. Bubblewrap separates all visitor-controlled processes from the Docker supervisor's namespace capability and gives OpenCode a disposable filesystem/process view.

The child and controller still share the Codespace host kernel. A kernel or container-runtime escape can cross the intended boundary. Outbound networking is intentionally available. Visitors in the same ttyd cohort share one tmux/OpenCode session and can observe and control the same terminal state.

## File map

- `devcontainer.json` selects the controller image, declares port 7681, and wires lifecycle hooks.
- `controller.Dockerfile` builds the trusted controller on top of the validated demo image.
- `Dockerfile` builds the public runtime, pinned Bubblewrap, OpenCode bootstrap, plugin dependencies, Python cache, and source snapshot.
- `start-demo-sandbox.sh` updates and verifies OpenCode, recreates the Docker child, and waits for readiness.
- `run-demo-sandbox.sh` defines the outer Docker security, resource, filesystem, network, and logging boundary.
- `run-demo-container.sh` owns disposable cohort workspaces and invokes the nested sandbox.
- `opencode-ephemeral.sh` creates the Bubblewrap namespace/filesystem boundary, drops public privileges, and supplies ephemeral OpenCode state.
- `publish-demo.sh` publishes and verifies the ready Codespaces port.
