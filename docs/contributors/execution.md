# Execution boundary

A live session crosses three processes:

```text
Browser ⇄ Node backend ⇄ sandboxed Python container
```

The browser renders and sends user commands. The backend authorizes, supervises, stores metadata, and relays. The container runs the harness, environment, and agents.

Read [the execution specification](../specs/execution.md) for the architectural rules, [Frontend](frontend.md) for the browser host, and [Backend](backend.md) for storage and HTTP routes.

## Execution driver

`backend/src/driver/index.ts` is a platform-neutral interface. It must not import Docker code.

`ExecutionDriver` provides:

- `ensureImage(spec)`
- `launch(spec)`
- Overlay-image listing and removal

`SessionProcess` provides:

- Ordered outbound lines.
- `send(line)` for inbound commands.
- Diagnostics.
- An exit promise with an `oomKilled` flag.
- `kill(graceMs)` as the final backstop.

The interface promises an ordered, newline-delimited, bidirectional UTF-8 channel. It does not expose file descriptors, ports, or a particular attach mechanism.

The Docker implementation lives under `driver/docker/`. A later Kubernetes implementation can choose a different transport without changing the orchestrator.

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

## Session base images

Each supported dependency version has a concrete base-image definition:

```text
backend/images/session-base/deps-v<N>/
```

`backend/src/deps-version.ts` is the registry. A template version is valid only when this registry points to its Dockerfile.

Each base contains:

- Harness and environments.
- Frozen dependency set.
- Built-in Naive agent.
- `python -m game_sandbox_harness.live` entrypoint.

The image tag is `game-sandbox/session-base:deps-v<N>`. The driver either reuses or rebuilds it according to `DOCKER_IMAGE_POLICY`.

After changing a current image input, rebuild it from `backend/`:

```console
npm run build:image
```

## Submission overlay images

A validated submission adds source code to the season's base image. It never installs submission-specific dependencies.

`submission/submission-image.ts`:

- Copies source to `/opt/agents/submissions/<slotId>`.
- Selects the matching `deps-v<N>` base.
- Tags the overlay from dependency version and submission ID.
- Applies `SUBMISSION_BUILD_TIMEOUT_MS`.

An evicted overlay can be rebuilt from the pinned source.

### Load check

Before an overlay becomes ready, `submission/validate/load-check.ts` launches it with the real sandbox profile and runs:

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

### Overlay eviction

The overlay sweep runs at startup, on its timer, and after a successful build. It:

1. Lists overlay images through the driver.
2. Protects active ready submissions.
3. Counts protected images toward the budget.
4. Deletes remaining images oldest first until within `OVERLAY_IMAGE_BUDGET`.

Removal is best-effort because every overlay is reproducible.

## Container transport

Container output is JSONL. One rule classifies every line:

- A top-level `kind` means an event envelope.
- No top-level `kind` means a recording header or step state.

Recording lines pass through unchanged and are written to the recording. Event envelopes are control or result data and are not recording lines.

Inbound commands are:

```json
{"kind":"input","slot":"player_0","action":1}
{"kind":"pause"}
{"kind":"resume"}
{"kind":"stop"}
```

Messaging adds a `chat` event. Unknown or malformed commands are logged and ignored.

The final `result` event contains ticks, scores, termination reason, timeout counts, and recording ID.

## Browser WebSocket

The browser receives:

- Header and state lines.
- Final result.
- Pause and resume echoes.
- Backend session-status events.

On attachment, the backend immediately sends the buffered header, latest state, and current status.

The browser sends the same command envelopes used on the container side. The backend validates shape and authority, then forwards without interpreting environment actions.

Only the session owner can issue commands. Input also requires human mode and a human-capable slot. A slow socket is dropped instead of blocking the relay.

## Orchestrator lifecycle

`session/orchestrator.ts` starts a session in this order:

1. Validate environment and mode.
2. Check the session allowlist.
3. Enforce one active session per user.
4. Resolve seed and human timeout.
5. Resolve base or submission image.
6. Insert the `starting` storage row.
7. Launch the container.
8. Relay output through `LiveSession`.

The session configuration includes a `players` map for recording attribution. Human slots name the session owner, submitted slots name the submission and owner, and remaining agent slots name the built-in agent.

Every end path enters one idempotent finalizer. The first termination reason wins.

| Trigger                       | Reason                                     |
| ----------------------------- | ------------------------------------------ |
| Environment or harness result | `terminated`, `truncated`, `episode_limit` |
| Owner stop                    | `stopped`                                  |
| No socket or human command    | `idle_timeout`                             |
| Wall-clock backstop           | `time_limit`                               |
| Memory kill                   | `oom_killed`                               |
| Other crash                   | `error`                                    |

The finalizer stores the result, notifies clients, kills the container if needed, and clears the active registry.

## Container-side live runner

`python -m game_sandbox_harness.live` uses the same `Episode.step_once` path as headless execution.

The only pacing branch reads environment metadata:

- With `pace_interval_ms`, wait for the cadence and use the latest latched human input.
- Without it, block for a turn-based human action until the move clock expires.

Pausing uses a `PausableClock`, so cadence and decision-time accounting stop together. Headless runs do not construct this live loop.

The runner claims stdout for protocol traffic before importing games or agents. Each recording line is written once and mirrored to the live stream, so stored and streamed bytes are identical.

## Add a driver

1. Implement `ExecutionDriver` in a sibling directory under `driver/`.
2. Map `SandboxProfile` to the platform.
3. Provide an ordered line channel.
4. Implement image enumeration and removal.
5. Add integration tests for limits, teardown, and recovery.

Biome enforces dependency boundaries: Docker stays in `driver/docker/`, database engines stay in `storage/`, and Git access stays in `submission/source/`.
