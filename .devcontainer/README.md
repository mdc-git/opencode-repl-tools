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
  ├─ setup capabilities only: CHOWN, DAC_OVERRIDE, SETGID, SETPCAP, SETUID, SYS_ADMIN
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
  ├─ disposable Bubblewrap home/state
  ├─ read-only system/runtime assets
  └─ ttyd :7681
       └─ one run-demo-client per browser connection
            ├─ private /tmp/opencode-client.XXXXXX root
            ├─ private HOME/XDG/database/cache/state/config
            ├─ private writable workspace
            └─ OpenCode V2
             │
             ▼
  127.0.0.1:7681 → GitHub Codespaces port forwarding
```

The controller owns Docker and GitHub authority. The Docker child has only the capabilities required to create the sandbox, prepare and manage private uid-1001 paths, and perform the one-shot identity/capability drop. It does not expose a shell or terminal before that drop. The public HTTP terminal, OpenCode process, plugin code, and visitor commands all run as uid/gid 1001 with an empty capability set inside Bubblewrap.

## Image and runtime model

The demo image contains the OpenCode bootstrap executable, Bun, Bubblewrap 0.12.0, ttyd, Node.js, Python, production plugin dependencies, a read-only prebuilt Python REPL environment, and a source snapshot containing `.opencode` and the plugin source.

Bubblewrap 0.12.0 is built from its pinned upstream release tarball with the published SHA-256. The runtime does not use a setuid Bubblewrap executable.

At Codespace start, `start-demo-sandbox.sh` pulls the demo image, recreates the OpenCode runtime volume, and runs a disposable updater. The updater executes `opencode2 update --method bun`, verifies the resulting V2 executable, and exits. The Docker child mounts that runtime volume read-only. A separate Bun download-cache volume is available only to the updater.

## Docker child

`run-demo-sandbox.sh` starts the child with:

- uid/gid `0:0` for the trusted supervisor
- read-only root filesystem
- all capabilities dropped, then only `CHOWN`, `DAC_OVERRIDE`, `SETGID`, `SETPCAP`, `SETUID`, and `SYS_ADMIN` added
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

Docker's default seccomp and AppArmor profiles are disabled because the trusted supervisor must create the Bubblewrap mount/process namespaces. `CHOWN` and `DAC_OVERRIDE` are used only while constructing and cleaning up private uid-1001 paths. `SETUID`, `SETGID`, and `SETPCAP` are passed only to the one-shot `setpriv` process that changes identity and clears the capability bounding set. Visitor-controlled processes never run with supervisor capabilities.

The image strips SUID/SGID bits and removes world-writable permissions from immutable image content.

## Session lifecycle

`run-demo-container.sh` starts from a sanitized environment, creates the long-lived Bubblewrap sandbox, drops to uid/gid 1001 with zero capabilities, and starts one ttyd listener with no client-count limit.

The public process tree is:

```text
run-demo-container        trusted root supervisor
  └─ opencode-ephemeral   trusted Bubblewrap setup
       └─ bwrap
            └─ setpriv uid=1001 gid=1001 caps=none
                 └─ ttyd :7681
                      ├─ run-demo-client → opencode2 --standalone <client workspace>
                      ├─ run-demo-client → opencode2 --standalone <client workspace>
                      └─ ...
```

For every ttyd connection, `run-demo-client.sh` creates a unique `/tmp/opencode-client.XXXXXX` root inside the Bubblewrap tmpfs. It copies the baked source snapshot into that client's writable workspace, links immutable Node dependencies and the read-only prebuilt Python REPL cache, starts OpenCode, and deletes the entire client root when the connection ends. Browser clients do not share an OpenCode process, database, writable cache, state directory, config directory, home directory, temp directory, or workspace.

## Per-client OpenCode state

Each client receives its own generated prefix:

```text
CLIENT_ROOT=/tmp/opencode-client.XXXXXX
HOME=$CLIENT_ROOT/home
TMPDIR=$CLIENT_ROOT/tmp
XDG_CONFIG_HOME=$CLIENT_ROOT/xdg/config
XDG_DATA_HOME=$CLIENT_ROOT/xdg/data
XDG_CACHE_HOME=$CLIENT_ROOT/xdg/cache
XDG_STATE_HOME=$CLIENT_ROOT/xdg/state
OPENCODE_CONFIG_DIR=$CLIENT_ROOT/xdg/config/opencode
OPENCODE_DB=$CLIENT_ROOT/xdg/data/opencode/opencode.db
NPM_CONFIG_CACHE=$CLIENT_ROOT/xdg/npm
```

The checked-in project configuration is copied into each private workspace, so its local `"./"` plugin entry continues to resolve to the bundled REPL plugin source. The prebuilt Python REPL cache is the only cache subtree deliberately shared between clients, and it is mounted/read through an immutable image path. Node dependencies are also shared read-only. All generated OpenCode database, cache, state, configuration, home, temp, and project files are client-local and disappear when that client's launcher exits.

`opencode-ephemeral.sh` still supplies a disposable Bubblewrap-level home/XDG environment for direct sandbox commands and smoke probes. Public OpenCode clients override those writable paths with their own per-connection prefix before OpenCode starts.

## Network model

The controller uses host networking. The Docker child uses bridge networking and publishes `127.0.0.1:7681` on the Codespace host. Bubblewrap shares only the Docker child's network namespace, so OpenCode can make outbound requests without receiving the controller's host network namespace.

Codespaces forwards the loopback listener and provides the public HTTPS endpoint. `publish-demo.sh` makes the forwarded port public only after readiness succeeds and verifies its visibility through `gh`.

## CI contract

`.github/workflows/build-demo-image.yml` validates the deployment boundary before publishing images. The sandbox smoke test requires:

- OpenCode V2 seed availability
- exactly Bubblewrap 0.12.0
- successful execution of a command as uid 1001 through `opencode-ephemeral`
- a real OpenCode TUI process inside Bubblewrap
- two client launches inside one Bubblewrap sandbox receiving different `/tmp/opencode-client.*` roots
- client-local HOME, TMPDIR, XDG config/data/cache/state, `OPENCODE_CONFIG_DIR`, `OPENCODE_DB`, and npm cache paths
- removal of client roots after their launchers exit
- uid 1001 and zero inheritable, permitted, effective, bounding, and ambient capabilities for public processes
- the explicit supervisor setup-capability allowlist
- read-only rootfs and runtime volume
- resource limits, bridge networking, and private cgroup namespace
- required Docker seccomp/AppArmor settings
- absence of host binds, Docker socket, controller checkout, and GitHub credentials
- read-only source, dependencies, and Python cache
- absence of SUID/SGID and world-writable immutable image content

Only after the sandbox passes is the demo image published. The controller image is then built from that validated image and exercised through the Dev Container CLI, including the startup updater and end-to-end listener.

## Security boundary and residual risk

The controller/public-child split protects the repository checkout, GitHub credentials, Docker authority, and controller filesystem. Bubblewrap separates all visitor-controlled processes from the Docker supervisor's setup capabilities and gives OpenCode a disposable filesystem/process view.

Concurrent browser sessions use distinct generated state paths but run under the same uid inside the same Bubblewrap namespace. The per-client prefixes prevent normal OpenCode state/cache/database reuse; they are not an additional hostile-client security boundary between sessions. The child and controller still share the Codespace host kernel. A kernel or container-runtime escape can cross the intended boundary. Outbound networking is intentionally available.

## File map

- `devcontainer.json` selects the controller image, declares port 7681, and wires lifecycle hooks.
- `controller.Dockerfile` builds the trusted controller on top of the validated demo image.
- `Dockerfile` builds the public runtime, pinned Bubblewrap, OpenCode bootstrap, plugin dependencies, Python cache, and source snapshot.
- `start-demo-sandbox.sh` updates and verifies OpenCode, recreates the Docker child, and waits for readiness.
- `run-demo-sandbox.sh` defines the outer Docker security, resource, filesystem, network, and logging boundary.
- `run-demo-container.sh` starts the long-lived Bubblewrap/ttyd listener.
- `run-demo-client.sh` creates and removes one private OpenCode state/workspace prefix per ttyd connection.
- `opencode-ephemeral.sh` creates the Bubblewrap namespace/filesystem boundary, drops public privileges, and supplies disposable sandbox-level OpenCode state.
- `publish-demo.sh` publishes and verifies the ready Codespaces port.
