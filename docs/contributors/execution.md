# The execution boundary

A live session straddles the container boundary: a sandboxed container runs the Python harness and the game, and the Node backend supervises it and relays its state to the browser. This page describes that seam: the execution-driver interface, the sandbox profile, the transport between container and backend, the WebSocket protocol between backend and browser, the live runner inside the container, and how a second driver slots in. The design rationale lives in the [execution spec](../specs/execution.md) and the [interaction spec](../specs/interaction.md); this page is how it is built.

## The execution driver interface

`driver/index.ts` is a type-only seam with no implementation imports and no `dockerode`. An `ExecutionDriver` provides:

- `ensureImage(spec)`, which builds or fetches an image and returns a launch-ready reference.
- `launch(spec)`, which starts one session container and returns a `SessionProcess`.

A `SessionProcess` provides everything needed to supervise a running session:

- `output`, the outbound line channel.
- `send`, for inbound lines.
- `diagnostics`, for logging.
- `exited`, a promise containing the exit code and driver-neutral `oomKilled` flag.
- `kill(graceMs)`, the final backstop.

The bidirectional channel is part of the abstraction, not something the layer above selects: the interface promises an ordered, newline-delimited, bidirectional UTF-8 text channel and says nothing about how it is carried. The local Docker driver carries it over attached stdio; a Kubernetes driver may use attach, exec, or a sidecar. Nothing above the interface may assume stdio, file descriptors, or ports.

Stage 5 grows the same interface with overlay-image management, used by the eviction sweep below: `listOverlayImages()` enumerates the built overlay images as `{ref, submissionId, createdAtMs}` records (the submission id recovered from the deterministic tag), and `removeImage(ref)` deletes one best-effort, tolerating an already-absent image. `ensureImage` gains a `submission-overlay` `ImageSpec` (`{kind: 'submission-overlay', depsVersion, submissionId, sourceTreePath, slotId}`) alongside the `session-base` one. All of it stays driver-neutral: a second driver enumerates and removes its own images however it likes.

## The sandbox profile

`SandboxProfile` describes the sandbox without naming a platform:

- `cpus`
- `memoryMb`
- `readOnlyRoot`, always true
- `scratch`, a writable tmpfs with a container path and size
- `network`, currently `none`
- `mounts`, currently used for the recordings volume

The Docker driver maps those values to `NanoCpus`, `Memory`, `MemorySwap`, `ReadonlyRootfs`, `Tmpfs`, `NetworkMode`, and `Binds`. It drops all capabilities and labels each container `game-sandbox.session=<id>`. When constructed, the driver reaps leftover labeled containers so a backend restart begins cleanly.

## The session base image

One base image definition per supported dependency-set version, tagged `game-sandbox/session-base:deps-v<N>` (this stage needs only v1). `backend/src/deps-version.ts` is the explicit registry. A version is accepted by submission and season validation only when that registry points to a concrete Dockerfile, and the Docker driver rejects any unregistered version too. The v1 Dockerfile, frozen requirements, and frozen built-in `hello` agent live under `backend/images/session-base/deps-v1/` and build from the repo root, because the image also includes the `harness` and `environments` packages from source. The built-in agent is copied to `/opt/agents/builtin` as the **Naive agent** the frontend pins atop the watch list. Freezing both its dependency set and its own extra requirements prevents a later template release from changing a cold rebuild of the `deps-v1` tag. A new release adds a new versioned image directory and registry entry. The entrypoint is `python -m game_sandbox_harness.live`, and the orchestrator appends the session config as a single JSON argv element. Whether the driver rebuilds or reuses an existing tag is driver configuration (`imagePolicy`), not caller policy. The backend builds the image lazily on the first session and then reuses it, so a contributor who changed the current version's Dockerfile or a bundled source rebuilds it directly with `npm run build:image`, which forces a rebuild through that same driver build path without launching a session (see [running it locally](backend.md#running-it-locally)).

## From submission to overlay image

A validated submission becomes runnable by placing its code on the versioned base image selected by the season. Dependencies always come from the base image, so there is no per-submission dependency installation.

`submission/submission-image.ts`:

- Copies the prepared source tree to `/opt/agents/submissions/<slotId>`.
- Uses the correct `…:deps-v<N>` base.
- Creates a deterministic tag from `(depsVersion, submissionId)`, which lets eviction recover the submission id.
- Applies `SUBMISSION_BUILD_TIMEOUT_MS` so a hung build cannot block the worker indefinitely.

Under the default `reuse` policy, `ensureSubmissionImage` returns an existing overlay without fetching the source again. Under the `rebuild` policy, or after eviction, it fetches the pinned tree, rebuilds the overlay, and disposes the checkout. Every overlay can therefore be recreated on demand.

### The sandboxed load check

Before trusting an image, `submission/validate/load-check.ts` runs one **load check**. It launches the overlay with the same read-only root, disabled network, and quotas used by a real session, but runs `python -m game_sandbox_harness.validate` instead of the live loop. The agent is imported and instantiated once, without stepping an environment.

The backend:

- Races the container against `SUBMISSION_LOAD_CHECK_TIMEOUT_MS`.
- Drains stderr so the pipe cannot block.
- Reads one structured `validate-result` envelope from stdout.
- Passes on `ok: true`.
- Fails with the harness code and detail on `ok: false`.
- Reports `no_result` when no envelope arrives and `timeout` when the deadline expires.

### The harness `validate` command

`python -m game_sandbox_harness.validate <repo_root>` (`harness/src/game_sandbox_harness/validate.py`) is a sibling of the live runner that performs only the load check. It:

- Adds the repository root to `sys.path`.
- Imports the manifest's entry-point module.
- Instantiates the named class.
- Confirms that `reset` and `act` are callable.
- Never constructs or steps the environment.

It prints one `{"kind": "validate-result", ...}` envelope and exits with `0` on success or `1` on failure. Success includes `ok: true` and a `{learn, chat}` hooks map for the owner's debug view. Failure includes `ok: false`, a closed-set `code`, and a `detail`:

| `code` | Meaning |
| --- | --- |
| `import_error` | the entry-point module failed to import, or resolved outside the repo root |
| `class_not_found` | the manifest names a class the module does not define |
| `constructor_error` | instantiating the class raised |
| `missing_hook` | the instance has no callable `reset` or `act` |

Like the live runner, it claims the real stdout fd before importing any participant code and redirects participant prints to stderr, so a submission cannot spoof a passing `validate-result`: a test asserts exactly one envelope reaches the protocol stream and the planted one lands in stderr.

### Overlay-image eviction

Each built overlay leaves a cached image, so `submission/overlay-eviction.ts` keeps disk use bounded. The sweep runs:

- At startup.
- On the `OVERLAY_IMAGE_SWEEP_INTERVAL_MS` timer.
- After each successful build, which is the only time the set grows.

The sweep enumerates overlay images through `listOverlayImages()`, leaving base and unrelated images untouched. It protects images for active `ready` submissions, counts them toward the budget, and removes the remaining images oldest-first until the set fits within `OVERLAY_IMAGE_BUDGET`. `removeImage` is best-effort, and every overlay can be rebuilt on demand.

## The transport: line classification and envelopes

The outbound stream from the container is JSONL, and recording lines pass through unchanged so the wire form and the stored form stay one format. One rule classifies every line in both directions: a line is an **event envelope** when its top-level object carries a `kind`, and a **recording line** (the header or a per-step state) otherwise. The rule holds because the state schema declares no top-level `kind`, and a backend test asserts that against the packaged schema so it cannot rot silently.

The outbound `result` envelope is emitted once at session end and is never written to the recording. It includes ticks, scores, termination reason, step-timeout counts, and recording id.

Inbound commands from the backend to the container are:

- `{"kind":"input","slot":"player_0","action":<json>}`
- `{"kind":"pause"}`
- `{"kind":"resume"}`
- `{"kind":"stop"}`

Stage 8 adds `chat` with the same envelope shape. Unknown kinds and malformed lines are logged and ignored, so invalid client input cannot kill the container.

## The WebSocket protocol

The backend-to-browser protocol uses the same split. Server-to-client frames are the header and state lines relayed verbatim, the relayed `result` envelope, relayed `pause`/`resume` echoes so every attached client can show the paused state, and one backend-originated frame, `{"kind":"session","status":"running"|"ended","reason"?}`. On attach the backend immediately sends the buffered header, the most recent state, and the current status, so a renderer can draw without waiting for the next step; full catch-up and scrubbing belong to the Stage 4 replay viewer. Client-to-server frames are the same command envelopes as the container side. The backend validates the envelope shape and the sender's authority, then forwards: it never interprets an action, because the container is authoritative. Commands are honored only from the session owner, `input` only in human mode and only for a slot the environment exposes; a socket whose backlog crosses a threshold is dropped rather than letting one slow client stall the relay. Slot ids ride every input, so later multi-human sessions need no new transport. Because a browser cannot set a header on a WebSocket upgrade, the socket client carries the acting user as a `user` query parameter; `resolveUserId` reads the header first and that parameter second, so identity stays one function for both fetch and upgrade.

## The orchestrator and teardown

`session/orchestrator.ts` owns the lifecycle above the driver. Starting a session validates the environment and mode against the generated metadata (a 400), checks the user against the session allowlist (a 403), and enforces one active session per user (a 409 whose body carries the active session's id for the rejoin path), then resolves the seed and the human-slot timeout (the request override, else the metadata default), ensures the image, inserts the `starting` row, and launches one container with the sandbox profile and the session-config argv. A scripted session may name a `ready` submission for its non-human slot: the orchestrator resolves that submission's overlay image (the season's version, not this default) instead of the base, records the `session_submissions` attribution so the agent profile can join the run back to the submission, and otherwise runs the identical path. The watch flow for a submitted agent is a scripted session with a submission-named slot. `sessionConfig` also computes a per-slot `players` map it threads into the config argv, so the container writes it verbatim into the recording header: a human slot is attributed to the session owner, a submission-named slot to the submission owner and its id, and any other built-in slot to the "Naive agent". From there each session drives itself as a `LiveSession`: it consumes the container's output, buffers the header and latest state for late attachers, marks the row `running` when the header arrives, and relays everything to the attached sockets.

Every end path converges on one idempotent finalizer that records the reason, informs clients, kills the container, and clears the registry. The first caller's reason wins, so a later container result cannot overwrite an orchestrator decision.

Finalization can begin when:

- The container ends normally with `terminated`, `truncated`, or `episode_limit`.
- A client requests a stop, producing `stopped`.
- The idle window expires with no attached socket or, for a human session, no inbound command, producing `idle_timeout`.
- The wall-clock backstop fires, producing `time_limit`.
- The container is OOM-killed or crashes, producing `oom_killed` or `error`.

## The live session runner (container side)

Inside the container, `python -m game_sandbox_harness.live` is the harness's live runner. It is a second thin loop over the very same `Episode.step_once` that the headless `run_episode` uses; the only realtime-versus-turn-based difference is one conditional on the environment's pace interval, which is the "one code path reading the pace interval" the [interaction spec](../specs/interaction.md) requires.

- **Pacing.** For an environment with a pace interval (Flappy Bird, realtime) the loop waits until the next cadence instant before each step; for one with no interval (turn-based) it does not, and its external source blocks for input instead.
- **Pause.** Pausing freezes the cadence and the decision clock together: the injected `PausableClock` subtracts accumulated paused time, so every duration in the system: a step's decision budget, the next cadence instant: freezes with it, with no special case in the loop. Headless runs never construct a live loop, so they never pace and never pause.
- **The transport source.** An external human slot is fed by a `TransportSource` over a command pump that latches the latest input per slot. With a pace interval, it immediately returns the latched input or `None` and lets the loop handle pacing. Without an interval, it blocks in short slices until input arrives or the human-slot timeout expires. `None` uses the environment's default action, such as noop for Flappy Bird, without agent-timeout accounting.
- **Stdout hygiene and the tee.** The runner claims the real stdout for the protocol before any game import (PyGame prints a banner), so stray prints land in diagnostics. Every serialized line is written to the recording on the mounted volume and mirrored onto the protocol stream by the same writer, so the streamed bytes and the stored bytes are identical by construction.

## Adding a driver

A second driver, with Kubernetes as the planned example, is a pure addition. It implements `ExecutionDriver` in a sibling directory under `driver/`, maps `SandboxProfile` to its platform, and chooses its own line-channel transport. The orchestrator, relay, and protocol continue to depend only on `driver/index.ts`.

Biome enforces the boundary:

- `dockerode` is allowed only in `driver/docker/`.
- The database engine is allowed only in `storage/`.
- `simple-git` is allowed only in `submission/source/`.
- `child_process` remains banned everywhere.

Every file matches exactly one override, and CI checks the rule on every pull request.
