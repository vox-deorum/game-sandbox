# Stage 3: Backend and Live Sessions

Status: complete. All build-order steps are done, and the stage-03 documents match the implementation. Steps 1, 2, and 3 landed first. Step 1 added the backend package skeleton, the storage layer, and the generated `environments.json`. Step 2 added the driver-neutral execution-driver interface, the `FakeDriver` test double, and the import-isolation lint config. Step 3 added the `Episode` extraction in `session.py` behind the Stage 2 regression gate, the `live`/`live_io` modules, and their pytest suites. The remaining steps followed. Step 4 added the dockerode driver and the `session-base:deps-v1` image, with the memory-quota, no-network, and orphan-reaping driver tests. Step 5 added the orchestrator, the per-session relay, the `protocol` line-classification and command envelopes, and the Fastify HTTP/WebSocket API, all over the `FakeDriver`. Step 6 added the scripted-WebSocket-client, human-slot-timeout, and idle-timeout end-to-end tests as a Docker-gated Vitest project, plus the `backend-integration` CI job and the workspace-wide `check:ts`/`test:ts`. Step 7 added the [backend](../docs/contributors/backend.md) and [execution](../docs/contributors/execution.md) contributor pages; the live-runner section lives in the execution page, the natural home for the container side of the transport. The exit criteria below are met and exercised by the integration suite.

## Goal

The server side of a live session works end to end without a real frontend. The backend launches one sandboxed Docker container running the Stage 2 harness. It relays per-step states out over WebSocket. When a session is human-controlled, it feeds inputs back into a human-controlled slot. A test client standing in for the browser can play Flappy Bird, and scripted-agent sessions can also run for watch and recording tests.

## Plan documents

The detailed design lives under [stage-03/](stage-03/):

- [backend-skeleton-and-storage.md](stage-03/backend-skeleton-and-storage.md): the backend package and tooling, configuration, the identity stub, the single Kysely schema with derived domain types and the storage interface over SQLite, the generated environment metadata.
- [execution-driver-and-image.md](stage-03/execution-driver-and-image.md): the driver interface and sandbox profile, the dockerode driver, the session base image with the built-in agent, the import-isolation lint rule.
- [transport-and-live-runner.md](stage-03/transport-and-live-runner.md): the container and WebSocket protocol layers, the line-classification rule, the `Episode` refactor, the paced and pausable live runner in the harness.
- [orchestrator-and-http-api.md](stage-03/orchestrator-and-http-api.md): the session lifecycle and teardown paths, the relay, the HTTP API and the WebSocket endpoint.
- [testing-ci-and-docs.md](stage-03/testing-ci-and-docs.md): the test suites that encode the exit criteria, the Docker-gated integration job, CI wiring, the docs pages.

## Scope

Stand up the Node/TypeScript backend in `backend/`. The following was confirmed at stage start. Use Fastify with `@fastify/websocket` for HTTP and WebSocket, dockerode for container control (confined to the local Docker driver, see below), and SQLite through better-sqlite3 with Kysely behind a thin storage layer. The storage layer holds the relational data that later stages add: sessions now, then submissions, seasons, and ratings later. The storage layer is an interface that speaks domain types derived from a single Kysely table schema. That schema is the one declaration of the stored data; there is no parallel hand-maintained type set. Swapping SQLite for another engine means wiring a different Kysely dialect, not writing a second schema or implementation. The environment metadata the backend serves is a generated, committed JSON artifact under the existing staleness check, so the backend never runs Python.

Build the session base image with Python, the harness package, PettingZoo, the environments, and the template dependency set. Base images are keyed by dependency-set version per [execution.md](../docs/specs/execution.md), though this stage only needs the current version. Stage 5 overlays submission code on top. In this stage, the base image includes a built-in scripted agent so watch-style runs can be exercised before submissions exist. Human-controlled Flappy Bird sessions use the same harness slot with WebSocket input.

Define the execution driver interface from [execution.md](../docs/specs/execution.md) before writing any container code. The interface must build or fetch an image, launch a session with a driver-neutral sandbox profile, stream its I/O, and tear it down. Implement the local Docker driver (dockerode) as the first and, for now, only implementation. A Kubernetes driver comes later and must slot in without changes above the interface. So nothing outside the driver may import dockerode, shell out to Docker, or assume Docker-specific semantics. Image caching behavior is configuration on the driver.

Implement the session orchestrator against that interface, per [execution.md](../docs/specs/execution.md) and [frontend.md](../docs/specs/frontend.md). The orchestrator launches one container per session and applies the sandbox profile: fixed CPU and memory quotas, a read-only filesystem with a writable scratch directory, and no network in this stage (the internal gateway-only network arrives in Stage 9 for LLM-enabled sessions). It mounts the recordings volume, supervises the container, and tears it down when the session ends, the episode terminates, the environment time limits expire, or the idle timeout fires. Enforce one concurrent session per user. The user identity is a stub until Stage 4 brings OAuth.

Define the transport between container and backend. The outbound state stream from the harness is JSONL, using the same header and per-step state lines that recordings use (see [recording.md](../docs/specs/recording.md)). Inputs, pause and resume, and later chat messages are not recording lines. They use a separate command envelope with a message kind, a slot ID where applicable, and a payload. The envelope is carried over the bidirectional line channel the execution driver provides. The following was confirmed at stage start: the channel is part of the driver abstraction, the local Docker driver carries it over attached stdio, and nothing above the driver may assume the carrier. Define the WebSocket protocol between backend and browser with the same split: state objects out; human inputs and, from Stage 8, chat messages in as commands. Implement the single session loop from [interaction.md](../docs/specs/interaction.md). For an environment with a pace interval set (realtime, Flappy Bird), the harness advances on that wall-clock cadence and takes the latest input per step for human-controlled slots, or a noop. For an environment with no pace interval (turn-based), it advances as each slot acts. This is one code path reading the pace interval, not two. The pace clock is pausable from a live session: pausing freezes the cadence and the decision clock together until resume; headless runs never pace and never pause. The backend stays a relay; the container is authoritative. Session start accepts a human-slot timeout override, defaults it from environment metadata, and passes the resolved value into the harness. This stage only needs Flappy Bird's single controllable slot, but the protocol should carry slot IDs so later multi-human sessions do not need a new transport.

Expose the minimal HTTP API the frontend will need: list environments with their public metadata, start a session, attach to a session's WebSocket, list and fetch recordings.

## Spec references

[execution.md](../docs/specs/execution.md) (container model, sandboxing, languages, transport contract), [interaction.md](../docs/specs/interaction.md) (session loop, human input), [frontend.md](../docs/specs/frontend.md) (on-demand live play limits), [recording.md](../docs/specs/recording.md) (shared volume).

## Depends on

Stage 1 (types from schema), Stage 2 (harness, base image contents).

## Done when

A scripted WebSocket test client starts a session, receives schema-valid states at the environment's pace cadence, and sends flap inputs that visibly affect the game. The recording appears on the shared volume when the session ends. A second test starts a human-controlled session with a short human-slot timeout and verifies that missing input resolves to noop while the session keeps moving. A container that exceeds its memory quota or runs past the idle timeout is killed and reported cleanly. The container demonstrably has no network access. No module outside the local Docker driver references Docker APIs, verified by a lint rule or dependency check, so the Kubernetes driver remains a pure addition.

## Build order

1. The backend package skeleton: workspace membership, tooling, config, the identity stub, the storage layer (the Kysely schema and derived domain types, the interface, SQLite wiring, and the fresh-build schema bootstrap with the `sessions` table), and the generated `environments.json` through `scripts/generate.py` and the staleness check.
2. The driver interface types, the `FakeDriver` test double, and the import-isolation lint configuration. Can run in parallel with 1.
3. The protocols and the live runner: the `Episode` extraction in `session.py` with the Stage 2 suites as the regression gate, then the live modules with their pytest suites. Python-only; can run in parallel with 1 and 2.
4. The Docker driver and the session base image, with the driver-level integration tests (memory quota, no network, orphan reaping). Needs 2.
5. The orchestrator, the relay, and the HTTP API over the `FakeDriver`, with their unit suites. Needs 1 and 2.
6. End-to-end integration: the scripted WebSocket client criteria, the human-slot-timeout and idle-timeout tests, and the `backend-integration` CI job. Needs 3, 4, and 5.
7. Docs: the two contributor pages and the harness live-runner section.
8. Keep this file and the stage-03 documents in sync with whatever the implementation confirms or changes, per the [plan rules](README.md).

## Open questions

The idle-timeout definition and its default window are proposed in [stage-03/orchestrator-and-http-api.md](stage-03/orchestrator-and-http-api.md) and may be tuned during Stage 4 playtesting. The definition is either no socket attached, or additionally no inbound command for human sessions. The pace-cadence assertion tolerance in the integration tests can only be set honestly against real CI-runner jitter.

The import-isolation rule was an open question at stage start. `noRestrictedImports` was nursery-only at the then-pinned Biome 1.9.4, with an `scripts/ci.py` import-scan as the documented fallback. Step 2 resolved it by moving the repo to Biome 2.4.16, where the rule is stable in the `style` group; the fallback is no longer needed. See [stage-03/execution-driver-and-image.md](stage-03/execution-driver-and-image.md) for the implemented configuration.
