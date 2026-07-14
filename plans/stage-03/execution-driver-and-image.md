# Stage 3: The Execution Driver and the Session Image

Part of [Stage 3](../stage-03-backend-and-live-sessions.md). This file defines four things: the execution driver interface from [execution.md](../../docs/specs/execution.md) in driver-neutral terms, the local Docker implementation on dockerode, the session base image, and the lint rule that keeps Docker knowledge inside the driver so the Kubernetes driver stays a pure addition.

## The interface

`driver/index.ts` holds types only: no implementation imports. `ExecutionDriver` has two methods:

- `ensureImage(spec: ImageSpec): Promise<ImageRef>`: build or fetch the image for a spec. Whether an existing image is reused or rebuilt is driver configuration, not caller policy. This stage's only spec kind is `{kind: 'session-base', depsVersion}`; Stage 5 adds the submission-overlay kind on top.
- `launch(spec: LaunchSpec): Promise<SessionProcess>`: `LaunchSpec` is the image ref, the argv appended to the image entrypoint (the session config, see [transport-and-live-runner.md](transport-and-live-runner.md)), the sandbox profile, and the session id for labeling.

Confirmed during the build: `LaunchSpec` also carries an optional `entrypoint` that _replaces_ the image entrypoint. The orchestrator never sets it, since a session always runs the live-runner entrypoint with the config as argv. The driver-level sandbox tests (memory quota, no network) do set it, to run an arbitrary command in the base image, which keeps the production image free of test hooks. A Kubernetes driver maps it onto a container `command` the same way.

`SandboxProfile` expresses the sandbox in driver-neutral terms, per the spec:

- `cpus`.
- `memoryMb`.
- `readOnlyRoot` (always true).
- `scratch` (`containerPath` plus `sizeMb`).
- `network` (`none` in this stage; the internal gateway-only value arrives in Stage 9).
- `mounts` (host path, container path, read-only flag). The recordings volume is the one mount this stage uses.

Each driver maps the profile onto its platform. Backend launchers construct profiles through `driver/sandbox.ts`; the helper hard-codes `readOnlyRoot`, `network: 'none'`, and the `/tmp` scratch path, and accepts only quotas, scratch size, and caller-specific mounts. Live sessions, scheduled workflow games, and submission load checks therefore share one security boundary while retaining the mounts each job needs.

`SessionProcess` is the launched session, and it carries the transport decision confirmed at stage start: the bidirectional channel between backend and container is part of the driver abstraction, not something the layer above selects. The interface promises an ordered, line-delimited, bidirectional text channel and says nothing about how it is carried:

- `output: AsyncIterable<string>`: newline-stripped UTF-8 protocol lines out of the session.
- `send(line: string): void`: one protocol line into the session.
- `diagnostics: AsyncIterable<string>`: log output for the backend logger, never parsed as protocol.
- `exited: Promise<ExitInfo>`: exit code plus a driver-neutral `oomKilled` flag (Kubernetes reports OOMKilled too).
- `kill(graceMs): Promise<void>`: forceful teardown, escalating from polite stop to hard kill. Graceful session end is a protocol concern (the `stop` command); `kill` is the orchestrator's backstop.

The local Docker driver carries the channel over attached stdio; a Kubernetes driver may use attach, exec, or a sidecar: nothing above the interface may assume stdio, file descriptors, ports, or any other Docker semantics.

## The local Docker driver

`driver/docker/` implements the interface with dockerode against the local daemon. Container creation maps the profile directly: `NanoCpus`, `Memory` with `MemorySwap` set equal so swap does not soften the quota, `ReadonlyRootfs: true`, `Tmpfs` for the scratch path with its size cap, `NetworkMode: 'none'`, `Binds` for the mounts, `CapDrop: ALL`, and the label `game-sandbox.session=<id>`.

The driver attaches stdin/stdout/stderr before starting the container and demultiplexes with the Docker modem. Stdout is split into lines with partial-line buffering and becomes `output`, stderr becomes `diagnostics`, and `send` writes to stdin. `exited` resolves from `container.wait()` plus an inspect for `OOMKilled`, treating a 137 exit as OOM too when Docker omits the explicit flag. Containers are created without `AutoRemove` precisely so that inspect works, and the driver removes them after recording the exit info. `kill` is Docker stop with the grace period (SIGTERM then SIGKILL), then remove.

On construction the driver reaps orphans: any container carrying the `game-sandbox.session` label belongs to a previous backend process whose sessions no longer exist, so it is killed and removed. This keeps crashed-backend restarts clean without a supervisor.

The driver configuration is the daemon socket (dockerode defaults suffice on both Windows and Linux), the image tag prefix, and `imagePolicy: 'reuse' | 'rebuild'`. `reuse` returns an existing tag when present (the default); `rebuild` always rebuilds (a development convenience). This is the image-caching configuration the parent file requires to live on the driver.

## The session base image

There is one base image definition per supported dependency-set version, tagged `game-sandbox/session-base:deps-v<N>`, per [execution.md](../../docs/specs/execution.md). This stage needs only v1. `backend/src/deps-version.ts` explicitly registers each supported version with its Dockerfile, and the driver rejects an unregistered version instead of inferring support from the current version number. The v1 Dockerfile and frozen requirements snapshot live under `backend/images/session-base/deps-v1/` and build with the repo root as context, since the image also includes monorepo sources. The image is `python:3.12-slim`, plus the frozen dependency set copied from the v1 template release, then the `harness` and `environments` packages installed from source with `--no-deps` so the pinned set stays authoritative. A new dependency release adds a new versioned image directory and registry entry. It never reuses the current template requirements to rebuild an older tag.

The built-in scripted agent required by the parent file is the v1 `hello` example frozen under the same versioned image directory. The image copies that snapshot to `/opt/agents/builtin`, manifest included, and installs only its frozen extra requirement. It does not compose from the mutable current template during a rebuild. The live runner loads it through the same manifest loader a Stage 5 submission will use, so watch-style sessions exercise the real submission code path before submissions exist.

The image entrypoint is `python -m game_sandbox_harness.live`, and the launch argv carries the session config. The recordings mount point is a fixed container path (`/recordings`) that the entrypoint receives in its config.

Several details were confirmed during the build (`backend/images/session-base/deps-v1/Dockerfile`):

- `python:3.12-slim` needs `libglib2.0-0` for the SDL mixer PyGame imports, so one minimal apt layer installs it. The dummy SDL drivers mean no display or audio device, so there is no GL/ALSA stack.
- The harness installs _with_ its dependencies, not `--no-deps`, because its one runtime dependency, `jsonschema`, is harness infrastructure that is not part of the student set and must be pulled in. The environments package still installs `--no-deps`, since its dependencies are the set.
- The built-in agent and its extra `wcwidth` pin are frozen beside the v1 Dockerfile and copied to `/opt/agents/builtin`, so a later template release cannot alter an old-tag rebuild.
- A build-time smoke step imports the environment and loads the built-in agent through the manifest loader, so a packaging error fails the build rather than the first session.
- This was also the first real (non-editable) wheel build of the `harness` package, which surfaced a latent duplicate-file bug in `harness/pyproject.toml`: the `schema_data` `force-include` overlapped the package walk. It is fixed there by excluding `schema_data` from the walk so the force-include is its single source.

## Keeping Docker inside the driver

Biome's `noRestrictedImports` rule denies `dockerode`, `child_process`, and `node:child_process` across `backend/src`, and the existing Biome CI check enforces it on every PR: the parent file's exit criterion. The same rule confines `kysely` and `better-sqlite3` to `backend/src/storage/`, per [backend-skeleton-and-storage.md](backend-skeleton-and-storage.md), so both isolation boundaries are one configuration.

The configuration is three `overrides` in the root `biome.jsonc`, partitioned by `includes` (with negated globs) so that every `backend/src` file matches exactly one and the restricted-import sets never have to merge:

- General backend code (everything except the two carve-outs) denies all four packages plus `child_process`.
- `backend/src/storage/**` re-permits `kysely` and `better-sqlite3` but still denies Docker and `child_process`.
- `backend/src/driver/docker/**` re-permits `dockerode` but still denies the database engine and `child_process`.

`driver/index.ts` is type-only and imports nothing restricted, which is what keeps the Kubernetes driver a pure addition: it implements the same interface in a sibling folder and the orchestrator never changes.

This required moving the repo from Biome 1.9.4 to 2.4.16, where `noRestrictedImports` is stable in the `style` group rather than the 1.9 nursery, so the stage-start fallback (an import-scan check in `scripts/ci.py`) is unnecessary and dropped. The config is `biome.jsonc`, not `biome.json`, because the override partition carries an explanatory comment, and Biome silently ignores comments in a plain `.json` config: the rule then quietly stops applying. The `.jsonc` extension is the supported way to comment a Biome config. A side note for anyone extending the rule: `noRestrictedImports` flags imports that bind a value or namespace, not bare side-effect imports (`import 'pkg'`).
