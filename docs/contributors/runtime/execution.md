# Execution boundary

A production live session crosses three processes:

```text
Browser ⇄ Node backend ⇄ Python session container
```

The browser renders the game and sends user commands. The backend authorizes requests, supervises sessions, stores metadata, and relays traffic. The session container runs the harness, environment, and agents.

Read [the execution specification](../../specs/execution.md) for the architectural rules, [Frontend](../frontend/development.md) for the browser host, and [Backend](backend.md) for storage and HTTP routes.

## Execution driver

`backend/src/driver/index.ts` is a platform-neutral interface. It must not import Docker code.

`ExecutionDriver` provides:

- `ensureImage(spec)`.
- `launch(spec)`.
- Overlay-image listing and removal.

`SessionProcess` provides:

- Ordered outbound lines.
- `send(line)` for inbound commands.
- Diagnostics.
- An exit promise with an `oomKilled` flag.
- `kill(graceMs)` as the final backstop.

The interface guarantees an ordered, newline-delimited, bidirectional UTF-8 channel. It does not expose file descriptors, ports, or a specific attachment mechanism.

The Docker implementation lives under `driver/docker/`. This interface lets a later Kubernetes implementation use a different transport without changing the orchestrator.

## Sandbox profile

`SandboxProfile` describes:

| Field          | Meaning                   |
| -------------- | ------------------------- |
| `cpus`         | CPU quota                 |
| `memoryMb`     | Memory quota              |
| `readOnlyRoot` | Read-only root filesystem |
| `scratch`      | Bounded writable tmpfs    |
| `network`      | Network policy            |
| `mounts`       | Approved mounted paths    |

The Docker driver maps these to Docker settings, drops capabilities, and labels containers with `game-sandbox.session=<id>`. Startup reaps leftover labeled containers from an interrupted backend process.

`driver/sandbox.ts` builds profiles for live sessions, matches, and submission load checks. It always uses a read-only root filesystem and bounded `/tmp`. Callers choose `none` or `llm` networking, resource limits, scratch size, and approved mounts. Add new callers through this helper and extend its invariant tests.

An LLM-enabled session uses two Docker network boundaries. The session container joins only its per-session internal network and can reach only the `llm-proxy` alias. A fixed-destination relay joins that network and one backend-facing network, forwarding only to the backend's internal LLM listener. The session container never gets general internet access.

The backend-facing relay topology depends on where the backend runs:

- A host-process backend uses `host-gateway` mode. The relay joins a dedicated routed egress network and targets `host.docker.internal`.
- A Compose backend uses `compose-network` mode. The relay joins the configured existing Compose internal network (`game-sandbox-internal` by default) and targets the configured backend hostname (`app` in the provided Compose setup). It gets no separate egress network or host-gateway alias, and teardown never removes the shared Compose network.

Both modes leave the session container on the per-session network alone. Startup rejects incomplete relay configuration, and Compose-mode launch fails clearly when the configured network does not exist.

## Session base images

Each supported dependency version has a concrete base-image definition:

```text
backend/images/session-base/deps-v<N>/
```

`backend/src/build/deps-version.ts` is the registry. A template version is valid only when this registry points to its Dockerfile.

Each base contains:

- Harness and environments.
- Frozen dependency set.
- Every declared builtin agent for the environment. An environment can declare more than one: Spades bundles both a Naive agent and a Cautious bidder.
- `python -m game_sandbox_harness.live` entrypoint.

The image tag is `game-sandbox/session-base:deps-v<N>`. The driver either reuses or rebuilds it according to `DOCKER_IMAGE_POLICY`.

To make the image fresh, run this from `backend/`; it rebuilds only when an image input changed and reuses the existing image otherwise:

```console
npm run build:image
```

## Submission overlay images

A validated submission becomes an overlay image: the submission's built image layered on the session base image. It adds source code only and never installs submission-specific dependencies.

`submission/submission-image.ts`:

- Copies source to `/opt/agents/submissions/<seatId>`.
- Selects the matching `deps-v<N>` base.
- Tags the overlay image from dependency version and submission ID.
- Applies `SUBMISSION_BUILD_TIMEOUT_MS`.

An evicted overlay image can be rebuilt from the pinned source.

### Load check

Before an overlay image becomes ready, `submission/validate/load-check.ts` launches it with the real sandbox profile and runs:

```console
python -m game_sandbox_harness.validate <repo_root>
```

The command imports the module, constructs the named class, and checks that `reset` and `act` are callable. It never creates or steps an environment.

The harness emits one `validate-result` event:

| Code | Meaning |
| --- | --- |
| `import_error` | Module failed to import or resolved outside the repository |
| `class_not_found` | Manifest class does not exist |
| `constructor_error` | Class construction raised |
| `missing_hook` | Required hook is absent or not callable |

The runner claims the protocol stdout before importing participant code and redirects participant prints to stderr. Participant code therefore cannot spoof a successful result.

### Overlay image eviction

The overlay image sweep runs at startup, on its timer, and after a successful build. It:

1. Lists overlay images through the driver, from both the `submission-overlay` and `session-overlay` repositories.
2. Protects active ready submissions.
3. Counts protected images toward the budget.
4. Deletes remaining images oldest first until within `OVERLAY_IMAGE_BUDGET`.

Removal is best-effort because every overlay image is reproducible.

Composed `session-overlay` images are single-use: the orchestrator and workflow runner release one on every path — when its session or game ends, and when a cancelled run or failed launch backs out before a session ever starts. Anything still present is a release that failed, crashed, or never ran, or a leaked `-stage` build intermediate. So the sweep reclaims session overlays by age alone: images younger than `SESSION_OVERLAY_RECLAIM_AGE_MS` are never evicted (a compose can be mid-build at the sweep), and anything older — or a `-stage` intermediate — is reclaimed outright, so even a single low-count leak is eventually swept rather than stranded by a small retained set.

## Container transport

Container output is JSONL. One rule classifies every line:

- A top-level `kind` means an event envelope.
- No top-level `kind` means a recording header or step state.

Recording lines pass through unchanged into the recording. Event envelopes carry control or result data and are not recorded.

Inbound commands are:

```json
{"kind":"input","player":"player_0","action":1}
{"kind":"clock","player":"player_0","running":true}
{"kind":"chat","player":"player_0","to":null,"text":"hello"}
{"kind":"pause"}
{"kind":"resume"}
{"kind":"stop"}
```

Messaging adds a `chat` event. Unknown or malformed commands are logged and ignored. The initial Start gate of a paused launch always sends `resume`. After Start, a client sends `pause` and `resume` only for a human session of a `human_pause: "session"` environment. A watch session, and a started human session of a `human_pause: "playback"` environment, pause locally in the browser and send neither.

A `clock` event reports whether a human holds a player's controls, so the container spends that player's move budget only while they can act. The browser sends `running:true` when the renderer opens the move clock and `running:false` when it closes or playback pauses. Like `input`, the event is accepted only from the owner, in human mode, for a human-capable player. When the last owner socket detaches, the backend sends `running:false` for every external player so a disconnected browser cannot keep a budget running.

The final `result` event contains ticks, scores, termination reason, timeout counts, and recording ID.

## Browser WebSocket

The browser receives:

- Header and state lines.
- Final result.
- Pause and resume echoes.
- Backend session-status events, whose running form includes `awaiting_start`.

When a browser attaches, the backend immediately sends the buffered header, latest state, and current status. The running status says whether the first resume is still required. For a paused session, the backend then sends the current pause echo. The local bridge follows the same attachment contract.

The browser sends the same command envelopes used on the container side. The backend validates shape and authority, then forwards without interpreting environment actions.

Only the session owner can issue commands. Input also requires human mode and a human-capable player. A slow socket is dropped instead of blocking the relay.

## Local play

Local play reuses the browser protocol and live runner without starting the backend or a container.

The local bridge, `game_sandbox_harness.local_server`, binds only to `127.0.0.1`. It serves the generated local browser bundle, starts the requested runner command, and relays protocol lines. The server accepts only the local page, environment metadata, static assets, and its WebSocket endpoint. It neither exposes the game to a network nor steps the game itself.

## Orchestrator lifecycle

`session/orchestrator.ts` starts a session after the route's `requireActive` guard confirms the user is active.

1. Validate environment and mode.
2. Enforce one active session per user.
3. Resolve seed and human timeout.
4. Resolve base or submission image.
5. Insert the `starting` storage row.
6. Launch the container.
7. Relay output through `LiveSession`.

The session configuration includes a `players` map for recording attribution. Human players name the session owner, submitted players name the submission and owner, and remaining agent players name the builtin agent.

Every exit path enters the same idempotent finalizer. The first termination reason wins.

| Trigger                       | Reason                                     |
| ----------------------------- | ------------------------------------------ |
| Environment or harness result | `terminated`, `truncated`, `episode_limit` |
| Owner stop                    | `stopped`                                  |
| No socket or human command    | `idle_timeout`                             |
| Wall-clock backstop           | `time_limit`                               |
| Memory kill                   | `oom_killed`                               |
| Other crash                   | `error`                                    |

The finalizer stores the result, notifies clients, kills the container if needed, and clears the active registry. For LLM-enabled sessions, it blocks and settles proxy requests before cleaning up telemetry and networks.

## Container-side live runner

`python -m game_sandbox_harness.live` and headless execution both call `Episode.advance()`. The environment's required `stepping` metadata selects one of two PettingZoo-specific paths:

- `Episode.step_once()` consumes one real AEC action and any required dead-step housekeeping.
- `Episode.step_tick()` snapshots every active parallel observation, gathers participant work sequentially, applies one joint action mapping, and records one multi-entry state.

Live pacing keeps separate scheduler branches:

- Sequential paced environments retain their target cadence and use the latest latched human input.
- Simultaneous environments emit an opening state, wait one full interval before tick 0, and schedule every later boundary one interval after the previous tick completes. They never issue catch-up ticks.
- Sequential environments without a pace interval block for the acting human, and the move clock accumulates only while the browser reports the controls held. A browser that never reports them waits indefinitely, backstopped by the session's idle timeout and duration limit.

A session pause uses a `PausableClock`, so cadence and decision-time accounting stop together. A playback pause does not reach the stepping loop, which keeps stepping while the browser holds its own frames. Through `clock`, however, it reaches a turn-based move clock: pausing while you hold the controls stops your held time from accumulating until you resume. Headless runs do not construct this live loop.

The runner claims stdout for protocol traffic before importing games or agents. Each recording line is written once and mirrored to the live stream, so stored and streamed bytes are identical. The local bridge forwards those bytes unchanged and uses a caller-owned scratch recording directory.

### LLM hook timing

This timing machinery exists so an agent's LLM-call latency does not count against its own compute budget.

- An official LLM-enabled launch supplies `inflight_url` with the model endpoint and tick-marker URL.
- Before each hook, the harness restores the current player's base URL and credential. `reset` uses the setup marker. `act`, `chat`, and `learn` use the current tick marker, which the harness posts when it changes. Around each hook, the harness subtracts verified proxy time and reuses a valid reading as the next baseline. Hook-thread CPU remains chargeable, and a failed reading charges the whole hook.
- Module loading and construction are setup work, while reset is charged to the episode budget. `BackgroundLLM` may run across hooks and ticks, but watchdogs exclude only verified blocking proxy time, so background-marked requests never extend them.

See [LLM determinism and timing](../../specs/llm.md#determinism-and-timing).

## Add a driver

1. Implement `ExecutionDriver` in a sibling directory under `driver/`.
2. Map `SandboxProfile` to the platform.
3. Provide an ordered line channel.
4. Implement image enumeration and removal.
5. Add integration tests for limits, teardown, and recovery.

Biome enforces dependency boundaries: Docker stays in `driver/docker/`, database engines stay in `storage/`, and Git access stays in `submission/source/`.
