# Stage 3: Testing, CI Wiring, and Docs

Part of [Stage 3](../stage-03-backend-and-live-sessions.md). This file makes the exit criteria executable, split by what they need: backend unit tests on a fake driver, Python live-runner tests on `ManualClock`, and Docker-gated integration tests for the criteria that only mean something against a real container.

Status: implemented. The unit suites live under `backend/test/` and run with the default `vitest.config.ts`. The Docker-gated suite is a second project (`backend/vitest.integration.config.ts`) whose global setup pings the daemon and builds the base image once; it runs with `npm run test:integration` and the `backend-integration` CI job. Confirmed during the build: the integration suite's idle-timeout test uses a sub-second idle window, so it trips before a never-attached Flappy Bird session's bird falls and the episode ends on its own.

## Backend unit tests (Vitest, no Docker)

`backend/test/` carries a `FakeDriver`, an in-memory `ExecutionDriver` whose `SessionProcess` is scripted: tests feed it outbound lines and capture what `send` receives. The suites are:

- **Orchestrator lifecycle**: start inserts the row and launches with the right profile and argv; the resolved human-slot timeout lands in the session config; one session per user returns 409; each teardown path records its reason; finalize is idempotent under exit/idle/kill races; `oomKilled` and crash exits are reported cleanly (the orchestrator half of the memory-quota criterion: the container half lives in integration).
- **Relay and protocol**: recording lines broadcast verbatim; header, latest state, and status replayed to late attachers; the line-classification rule; envelope validation, slot authority, and unknown-kind tolerance; the slow-socket drop.
- **Storage**: the schema bootstrap (idempotent on reopen) and the interface methods on `:memory:`.
- **Generated metadata**: `environments.json` parses and every entry carries the fields the API serves.
- **Schema guard**: the packaged state schema defines no top-level `kind` property, so the classification rule cannot rot silently.

## Live-runner tests (pytest, ManualClock, in-process pipes)

- **Pacing**: a paced environment steps on cadence instants; two inputs inside one interval latch to the latest; no input yields the default action with the agent-timeout accounting untouched.
- **Pause**: pause mid-episode, advance the clock, resume: `decision_ms`, timeout accounting, and the cadence all exclude the paused span (`PausableClock` over `ManualClock`).
- **Unpaced path**: with no pace interval the step advances when input arrives, and the human-slot timeout applies the default: the same loop, one conditional.
- **Config**: the human-slot timeout override flows from session config into the `ExternalSlot`.
- **Stop**: the `stop` command closes a loadable recording, emits the `result` envelope, exits 0.
- **Stdout hygiene**: run the module as a subprocess; stray environment output lands on stderr and stdout contains only classifiable lines.
- **Tee parity**: streamed lines equal the recording file byte-for-byte.
- **Refactor regression**: the Stage 2 determinism fixtures pass unchanged over the `Episode` extraction, byte-for-byte.

## Integration tests (Docker required)

A separate Vitest project, `backend:integration`, gated behind an environment flag and a reachable Docker daemon. Setup builds the base image once. The remaining exit criteria live here:

- **The scripted WebSocket client** (a test-only TS client standing in for the browser) starts a human session, receives states that validate through the `@game-sandbox/schema` guards at the pace cadence (asserted with generous tolerance: CI runners jitter), sends flap inputs, and the run demonstrably diverges from an input-less run (altitude and score differ); after the session the recording exists on the shared volume and round-trips through the schema reader.
- **Human-slot timeout**: a short override and no input: states keep advancing on cadence via the noop fallback and the session never stalls.
- **Memory quota**: a driver-level launch of the base image with argv overridden to a memory hog under a small `memoryMb`, asserting `exited` reports `oomKilled`. Driver-level rather than a full session keeps the test deterministic and the production image free of test hooks; the reported-cleanly half is the orchestrator unit test above.
- **No network**: a driver-level launch whose argv attempts an outbound socket connection, asserting it fails immediately under `network: 'none'`: the container demonstrably has no network access.
- **Idle timeout**: a session with a tiny idle window and no attach is killed, reason `idle_timeout`, container removed.
- **Orphan reaping**: a labeled leftover container is removed when a new driver constructs.

## CI wiring

The root `check:ts` and `test:ts` scripts go workspace-wide, so the backend joins the existing `typescript` CI job with no YAML change. `scripts/ci.py` gains a `backend-integration` job running the gated Vitest project. In `ci.yml` it is a new job on `ubuntu-latest`, where the daemon is available; locally it needs Docker Desktop (an `act` run may skip it, and the job is also runnable directly). The `generated-code-fresh` job grows `backend/src/generated/environments.json`. The Biome `noRestrictedImports` configuration from [execution-driver-and-image.md](execution-driver-and-image.md) rides the existing Biome check. The new harness modules join the existing strict pyright, ruff, and pytest configuration with no tooling change.

## Docs

There are two contributor pages. `contributors/backend.md` covers package layout, config, storage, the identity stub, and how to run the backend locally. `contributors/execution.md` covers the driver interface and sandbox profile, the transport envelope and line-classification rule, the WebSocket protocol, and how to add a driver: the Kubernetes driver's future landing page. The live-runner section (pacing, pause, the transport source) landed inside `contributors/execution.md` rather than a separate harness page, because the live runner is the container side of the same execution boundary, so the two halves read together there. `contributors/test.md` gained the `backend-integration` job and the now-workspace-wide `typescript` job. Student pages are untouched: nothing participant-facing changes until submissions arrive in Stage 5.
