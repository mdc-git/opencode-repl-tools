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
             │ docker build + docker run
             ▼
  untrusted sandbox container (local runtime overlay on :demo)
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

`controller.Dockerfile` is based on the already validated `:demo` image. Pulling `:controller` therefore brings the sandbox filesystem layers into the same Docker daemon that will later start the child. `start-demo-sandbox` explicitly pulls `:demo` and uses it as the base of a small local runtime overlay, so those shared layers are reused instead of transferred again.

The sandbox Dockerfile keeps expensive work in independent build stages. Bun is used for JavaScript package installation in disposable builder stages only. OpenCode is installed from `@opencode/cli@beta`, its postinstall-selected native `opencode2` executable is resolved, and only that executable is copied into the sandbox runtime. Production plugin dependencies are installed from `bun.lock` with lifecycle scripts disabled, and only the resulting `node_modules` tree is copied into the runtime. Bun itself, its caches, and package-manager metadata do not become child runtime dependencies.

OpenCode V2 follows the rolling beta channel. CI resolves `@opencode/cli@beta` for the published image, while the plugin dependency is `@opencode/plugin: "beta"`. At every Codespace start, `start-demo-sandbox` independently resolves `@opencode/cli@beta` in a disposable Bun builder, overlays only the selected native executable onto the pulled `:demo` image, verifies that executable, and then launches the child. The public sandbox therefore starts with the current OpenCode V2 beta while retaining an immutable runtime filesystem.

## Codespace lifecycle

The Dev Container lifecycle commands are orchestration hooks, not service supervisors.

`postStartCommand` runs `/usr/local/bin/start-demo-sandbox`. It pulls `:demo`, creates a disposable Docker build context, resolves the current `@opencode/cli@beta` with Bun, builds and verifies the local `opencode-repl-tools-demo:runtime` overlay, removes any previous child with the fixed sandbox name, starts a detached hardened child from that runtime image, and waits until `http://127.0.0.1:7681/` responds. The hook then exits. The long-lived service remains owned by Docker, not by the Dev Container lifecycle process.

`postAttachCommand` runs `/usr/local/bin/publish-demo`. It waits for the local listener, runs `gh codespace ports visibility 7681:public`, verifies that GitHub reports the port as public, records the resulting URL, and opens it when a browser command is available.

This separation keeps container startup deterministic: service creation happens when the Codespace starts, while publication happens after attach when the Codespaces/GitHub command context is available.

## Sandbox hardening

`run-demo-sandbox.sh` is the security boundary for arbitrary visitor code. The child is started with the following properties:

| Control | Current setting | Purpose |
| --- | --- | --- |
| Identity | `1001:1001` | Do not run public code as container root. |
| Root filesystem | read-only | Prevent modification of the image and installed runtime. |
| Linux capabilities | `--cap-drop ALL` | Remove ambient kernel privileges. |
| Privilege escalation | `no-new-privileges` | Prevent gaining privilege through executable metadata. |
| Cgroup namespace | private | Avoid sharing the controller's cgroup namespace. |
| PID limit | 128 | Bound process-fork abuse. |
| Memory | 2 GiB | Bound memory abuse. |
| CPU | 2 CPUs | Bound CPU abuse. |
| File descriptors | 256 | Bound descriptor exhaustion. |
| Processes | 128 | Reinforce process limits inside the shell environment. |
| Core dumps | disabled | Avoid large or sensitive crash artifacts. |
| Home tmpfs | 512 MiB, `rw,exec,nosuid,nodev`, mode `0700` | Provide private disposable writable state and allow native OpenTUI shared libraries to be mapped. |
| `/tmp` tmpfs | 64 MiB, `rw,nosuid,nodev,noexec`, mode `0700` | Provide bounded temporary storage without executable mappings. |
| Network | Docker bridge | Keep the public process out of the controller's host network namespace. |
| Published port | `127.0.0.1:7681` only | Expose the child to Codespaces forwarding without a direct external Docker bind. |
| Bind mounts | none | Keep the checkout, Docker socket, host files, and controller state out of the child. |
| Logging | Docker `local`, 10 MiB × 2 | Bound persistent Docker log growth. |

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

Only after the sandbox passes those checks is `:demo` published. The workflow then builds `:controller` from that validated sandbox image, verifies its management tools, verifies that the real sandbox filesystem DiffIDs are an exact prefix of the controller filesystem layers, and publishes `:controller`. Finally, the Dev Container CLI brings up the repository configuration, exercises the startup OpenCode beta refresh, and verifies the controller host network, Docker socket, child bridge network, loopback port binding, and end-to-end listener readiness.

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
9. Resolve the rolling OpenCode V2 beta during Codespace startup in a disposable Bun builder and copy only the selected native executable into the local runtime overlay.
10. Keep Bun, its package-manager metadata, and its caches out of the public child runtime.
11. Build the trusted controller on top of the validated sandbox image so one Codespace image pull also preloads the expensive child layers.
12. Test the real terminal/session process in CI, not only the TCP or HTTP listener.
13. Verify public-port visibility after readiness rather than assuming publication succeeded.
14. Treat same-kernel escape, outbound egress, and shared-client terminal state as explicit residual risks rather than properties provided by container hardening.

## File map

| File | Responsibility |
| --- | --- |
| `devcontainer.json` | Select the prebuilt controller, provide host networking and Docker socket access, declare port 7681, and wire lifecycle hooks. |
| `controller.Dockerfile` | Build the trusted management image on top of `:demo` and add Docker CLI, `gh`, git, SSH, and orchestration scripts. |
| `Dockerfile` | Use Bun builder stages to assemble the native OpenCode executable and production plugin dependencies, then build the hardened public sandbox runtime with ttyd, Python dependencies, and the source snapshot. |
| `start-demo-sandbox.sh` | Pull `:demo`, resolve the current OpenCode beta in a disposable Bun builder, build and verify the local runtime overlay, recreate the child, bind it to loopback, and wait for readiness. |
| `run-demo-sandbox.sh` | Define the Docker security, resource, filesystem, network, and logging boundary for public code. |
| `publish-demo.sh` | Make the ready Codespaces port public, verify visibility, and record/open the public URL. |
| `run-demo-container.sh` | Sanitize the child environment and supervise ttyd/tmux cohorts inside the sandbox. |
| `run-demo-session.sh` | Create the disposable OpenCode home/workspace and launch the standalone TUI with preinstalled runtime dependencies. |
