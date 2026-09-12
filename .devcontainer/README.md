# Public Codespaces demo architecture

This directory implements the public browser demo for OpenCode REPL Tools. The design assumes that visitors can execute arbitrary code through OpenCode and therefore treats the public TUI as untrusted from the first instruction onward.

The central rule is simple: **the GitHub Codespace is the trusted controller; visitor code runs only in a separate sibling Docker container.** The controller owns the capabilities needed to manage the demo, while the child receives only the minimum runtime surface needed to run OpenCode.

## Architecture

```text
GitHub Codespace

  trusted controller container (:controller)
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
  untrusted sandbox container (:demo + read-only runtime volume)
  ├─ uid/gid 1001
  ├─ bridge network
  ├─ read-only root filesystem
  ├─ no capabilities
  ├─ no_new_privileges
  ├─ no bind mounts
  ├─ no Docker socket
  ├─ no GitHub credentials
  ├─ no controller checkout
  └─ ttyd → tmux → OpenCode V2
             │
             │ 127.0.0.1:7681 on the Codespace host
             ▼
  GitHub Codespaces port forwarding
             │
             ▼
  public HTTPS browser URL
```

`devcontainer.json` uses the prebuilt `ghcr.io/mdc-git/opencode-repl-tools-demo:controller` image directly. There is no controller image build and no Dev Container Feature installation during Codespace creation. The controller runs with host networking and receives the host Docker socket as an explicit bind mount.

The controller starts the child with Docker and publishes only the child's port 7681 onto `127.0.0.1:7681`. Codespaces forwards that local HTTP listener and provides the external HTTPS endpoint. The child itself remains on Docker's normal bridge network.

## Fast startup through shared image layers

The two published runtime images are deliberately related:

```text
:demo
  └─ hardened OpenCode runtime, plugin dependencies, Python cache, source snapshot
       └─ :controller
            └─ Docker CLI, gh, git, SSH client, controller scripts
```

`controller.Dockerfile` is based on the already validated `:demo` image. Pulling `:controller` brings that sandbox image's filesystem layers into the same Docker daemon that starts the child. `start-demo-sandbox` explicitly pulls `:demo` and resolves its local image ID for both the updater and child. Docker reuses matching layers; the moving tags can select images with different layers.

The sandbox Dockerfile keeps expensive work in independent build stages. OpenCode is installed from `@opencode/cli@beta` and updated with Bun during the image build. The selected native executable is copied into the image as the bootstrap executable. Production plugin dependencies are installed from `bun.lock` with lifecycle scripts disabled. The image contains Bun for the startup updater, while its persistent download cache is mounted only into the updater.

CI resolves `@opencode/cli@beta` for the published image, while the plugin dependency is `@opencode/plugin: "beta"`. At every Codespace start, a disposable updater runs `opencode2 update --method bun` against a fresh runtime volume, verifies the executable and its location, and exits before the child starts. The child mounts the resulting runtime read-only.

The updater uses a separate named volume at `/opt/opencode-update-cache` for Bun package downloads. Its disposable HOME contains `.bunfig.toml` with `install.cache.disableManifest = true`, so version resolution uses the registry while downloaded packages can be reused. The cache and runtime are separate volume mounts, preventing hardlinks between their files. Neither the cache nor the updater HOME is mounted into the public child. At updater entry and shell exit, a cache larger than 512 MiB is cleared. This bounds retained cache growth across completed runs, not transient installation disk usage; forced termination defers trimming until the next updater run.

## Codespace lifecycle

The Dev Container lifecycle commands are orchestration hooks, not service supervisors.

`postStartCommand` runs `/usr/local/bin/start-demo-sandbox` under an exclusive controller-side file lock. It pulls `:demo`, resolves its local image ID, removes existing updater and child containers, and recreates the runtime volume. Listing and removal failures abort startup; absent resources are allowed. A disposable updater updates and verifies OpenCode using the updater-only download cache. The hook then starts a detached hardened child from the same image ID and waits until `http://127.0.0.1:7681/` responds. The hook exits and releases the lock. The long-lived service remains owned by Docker, not by the Dev Container lifecycle process.

`postAttachCommand` runs `/usr/local/bin/publish-demo`. It waits for the local listener, runs `gh codespace ports visibility 7681:public`, verifies that GitHub reports the port as public, records the resulting URL, and opens it when a browser command is available.

Both hooks probe the listener directly with proxy use disabled, a one-second connection timeout, and a request timeout capped at two seconds or the remaining readiness budget. Startup uses a ten-second readiness deadline; publication uses thirty seconds. Failed probes are followed by a 100 ms sleep. Publication proceeds from the first successful probe without a duplicate HTTP request.

This separation keeps container startup deterministic: service creation happens when the Codespace starts, while publication happens after attach when the Codespaces/GitHub command context is available.

## Sandbox hardening

`run-demo-sandbox.sh` is the security boundary for arbitrary visitor code. The child runs with these controls:

- Identity is `1001:1001`, so public code does not run as container root.
- The root filesystem is read-only, preventing modification of the image and installed runtime.
- Linux capabilities are removed with `--cap-drop ALL`.
- `no-new-privileges` prevents privilege escalation through executable metadata.
- The cgroup namespace is private.
- The PID limit is 128.
- Memory is limited to 2 GiB.
- CPU is limited to 2 CPUs.
- File descriptors are limited to 256.
- Processes are limited to 128 inside the shell environment.
- Core dumps are disabled.
- The home tmpfs is 512 MiB with `rw,exec,nosuid,nodev` and mode `0700`.
- `/tmp` is a 64 MiB tmpfs with `rw,nosuid,nodev,noexec` and mode `0700`.
- Networking uses Docker bridge mode, keeping the public process out of the controller's host network namespace.
- Only `127.0.0.1:7681` is published, exposing the child to Codespaces forwarding without a direct external Docker bind.
- No bind mounts are provided, keeping the checkout, Docker socket, host files, and controller state out of the child.
- The runtime volume is mounted read-only; the updater's package-cache volume is not mounted into the child.
- Docker's `local` log driver is limited to two 10 MiB files.

The executable home tmpfs is intentional. OpenCode's Bun/OpenTUI runtime extracts native shared libraries into the session temporary directory and loads them with `dlopen`, which requires executable mappings. Arbitrary code execution is already the intended workload inside this container, so blocking executable mappings in the active session home does not create a meaningful code-execution boundary; it only prevents the TUI from functioning. `/tmp` remains `noexec` as a separate defense-in-depth control.

The child image also strips SUID/SGID bits and removes world-writable permissions from the image filesystem. Installed application content under `/opt` is root-owned and read-only to the public UID.

## Credential and environment isolation

The Docker socket and GitHub authentication exist only in the trusted controller. They are never mounted or copied into the public child.

The child starts with a deliberately small environment. `run-demo-container.sh` re-execs itself through `env -i`, and both ttyd and the OpenCode session are launched through additional `env -i` allowlists. The public process receives only the variables required for its runtime, such as `HOME`, `PATH`, locale information, and the configured Node/Python executable paths.

The source checkout is also not mounted. A read-only source snapshot is baked into `/opt/opencode-demo/source` in the image. Each OpenCode session copies that snapshot into its own writable session workspace instead of exposing the real repository checkout.

## TUI and session lifecycle

The sandbox container owns the public terminal lifecycle:

```text
run-demo-container
  └─ ttyd :7681
       └─ tmux session "opencode-demo"
            └─ run-demo-session
                 └─ opencode2 --standalone <workspace>
```

`ttyd` is writable, checks the request origin, allows at most four clients, and exits when the connection cohort is gone. `tmux` gives reconnecting clients a stable terminal during that cohort.

`run-demo-session.sh` takes an exclusive session lock, recreates `/home/opencode-demo/session`, copies the baked source snapshot into a private writable workspace, links the read-only preinstalled Node dependencies and Python cache, sanitizes the environment again, and starts OpenCode V2 in standalone mode.

When ttyd exits, the container wrapper kills the tmux server, removes the active session tree, and starts a fresh ttyd instance. The active OpenCode home and workspace are therefore cohort-scoped and disposable. The enclosing `/home/opencode-demo` tmpfs exists for the lifetime of the sandbox container; the sandbox itself is recreated whenever the Codespace start hook runs.

## Public port model

Port 7681 is declared as an HTTP forwarded port in `devcontainer.json`. The sandbox publishes to the Codespace host's loopback interface, and the trusted controller uses host networking so `127.0.0.1:7681` is the same listener that Codespaces sees for forwarding.

The local hop is HTTP. GitHub Codespaces provides the public HTTPS endpoint. `publish-demo` makes the forwarded port public only after the child has passed its readiness check and then verifies the visibility through `gh`.

A public Codespaces port is intentionally unauthenticated. The application behind it must therefore be safe to expose to arbitrary internet visitors under the sandbox assumptions described here.

## CI contract

`.github/workflows/build-demo-image.yml` treats the deployment architecture as an executable contract.

The workflow builds the sandbox, launches it with the same hardening script used in production, waits for ttyd, and then starts a real `run-demo-session` inside tmux. This verifies the OpenCode process itself rather than treating an HTTP listener as sufficient readiness. It also checks the child UID, read-only rootfs, resource limits, bridge network, private cgroup namespace, dropped capabilities, `no_new_privileges`, absence of bind mounts, absence of GitHub credential variables, absence of the Docker socket and checkout, and read-only installed content.

Only after the sandbox passes those checks is `:demo` published. The workflow then builds `:controller` from that validated sandbox image, verifies its management tools, and verifies that the real sandbox filesystem DiffIDs are an exact prefix of the controller filesystem layers. The Dev Container CLI brings up the repository configuration, checks that the controller uses the locally built candidate image, exercises the startup OpenCode beta refresh, and verifies the controller host network, Docker socket, child bridge network, loopback port binding, and end-to-end listener readiness. Only after that smoke check passes is `:controller` published.

The result is that the images consumed by Codespaces are produced ahead of time, while the OpenCode executable is refreshed at Codespace start and the same security and lifecycle assumptions are continuously exercised by CI.

## Security boundary and remaining risk

This design isolates public arbitrary code from the repository checkout, GitHub credentials, Docker authority, and controller filesystem. It is a container boundary, not a virtual-machine boundary.

The child and the trusted controller ultimately share the Codespace host kernel. A successful kernel or container-runtime escape could cross the intended boundary. The host Docker socket mounted into the controller is effectively host-root authority, which is why it must remain exclusively in the trusted controller and must never be passed to the public child.

Outbound networking is intentionally retained in the child so OpenCode connection flows can work. Public code can therefore make outbound network requests subject to the surrounding platform's network policy.

Visitors are not isolated from one another. Up to four ttyd clients attach to the same tmux/OpenCode cohort and can observe and control the same terminal state. The current design is suitable for a shared public demo, not for private per-visitor sessions. Per-visitor privacy would require a trusted gateway/orchestrator that creates a separate sandbox for each visitor.

## Working recipe

The implementation can be reduced to a small set of rules:

1. Keep the Codespace trusted and run arbitrary visitor code only in a sibling container.
2. Give Docker and GitHub authority to the controller only; give the child neither credentials nor host mounts.
3. Use host networking only for the controller and Docker bridge networking for the untrusted child.
4. Publish the child only to host loopback, then let Codespaces perform the external forwarding and TLS termination.
5. Make lifecycle hooks finite orchestration steps: start the detached service in `postStart`, publish the port in `postAttach`, and let Docker own the long-lived child.
6. Start from an immutable child image, add only bounded writable tmpfs storage, and explicitly allow executable mappings only where the native TUI runtime requires them.
7. Sanitize the environment at every trust boundary instead of trying to delete individual secret variable names after inheritance.
8. Bake dependencies and a source snapshot into the image; copy only disposable workspace state at session start.
9. Update OpenCode during every Codespace startup in a disposable updater, verify the executable, and mount its runtime volume read-only into the child.
10. Keep the updater download cache separate from runtime files and inaccessible to the public child, and resolve package versions from the registry on every update.
11. Build the trusted controller on top of the validated sandbox image so one Codespace image pull also preloads the expensive child layers.
12. Test the real terminal/session process in CI, not only the TCP or HTTP listener.
13. Verify public-port visibility after readiness rather than assuming publication succeeded.
14. Treat same-kernel escape, outbound egress, and shared-client terminal state as explicit residual risks rather than properties provided by container hardening.

## File map

- `devcontainer.json` selects the prebuilt controller, provides host networking and Docker socket access, declares port 7681, and wires lifecycle hooks.
- `controller.Dockerfile` builds the trusted management image on top of `:demo` and adds Docker CLI, `gh`, git, SSH, and orchestration scripts.
- `Dockerfile` uses Bun builder stages to assemble the native OpenCode executable and production plugin dependencies, then builds the hardened public sandbox runtime with ttyd, Python dependencies, and the source snapshot.
- `start-demo-sandbox.sh` serializes startup, pulls `:demo`, updates OpenCode in a disposable updater with a retained package cache, verifies the runtime, recreates the child using the same image ID and a read-only runtime volume, binds it to loopback, and waits for readiness.
- `run-demo-sandbox.sh` defines the Docker security, resource, filesystem, network, and logging boundary for public code.
- `publish-demo.sh` makes the ready Codespaces port public, verifies visibility, and records or opens the public URL.
- `run-demo-container.sh` sanitizes the child environment and supervises ttyd/tmux cohorts inside the sandbox.
- `run-demo-session.sh` creates the disposable OpenCode home and workspace and launches the standalone TUI with preinstalled runtime dependencies.
