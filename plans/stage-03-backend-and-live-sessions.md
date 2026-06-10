# Stage 3: Backend and Live Sessions

Status: not started

## Goal

The server side of a live session works end to end without a real frontend: the backend launches one sandboxed Docker container running the Stage 2 harness, relays per-step states out over WebSocket, and feeds inputs back into a human-controlled slot when a session is human-controlled. A test client standing in for the browser can play Flappy Bird, and scripted-agent sessions can also run for watch and recording tests.

## Scope

Stand up the Node/TypeScript backend in `backend/`. Proposed defaults, to be confirmed at stage start: Fastify (or plain Node http) plus the `ws` library for WebSocket, dockerode for container control (confined to the local Docker driver, see below), and SQLite behind a thin storage layer for the relational data that later stages add (sessions now; submissions, iterations, and ratings later). The storage layer is an interface so SQLite can be swapped without touching callers.

Build the session base image: Python, the harness package, PettingZoo, Shimmy, the environments, and the template dependency set. Base images are keyed by dependency-set version per [execution.md](../specs/execution.md), though this stage only needs the current version. Stage 5 overlays submission code on top; in this stage, the base image includes a built-in scripted agent so watch-style runs can be exercised before submissions exist, while human-controlled Flappy Bird sessions use the same harness slot with WebSocket input.

Define the execution driver interface from [execution.md](../specs/execution.md) before writing any container code: build or fetch an image, launch a session with a driver-neutral sandbox profile, stream its I/O, and tear it down. Implement the local Docker driver (dockerode) as the first and, for now, only implementation. A Kubernetes driver comes later and must slot in without changes above the interface, so nothing outside the driver may import dockerode, shell out to Docker, or assume Docker-specific semantics. Image caching behavior is configuration on the driver.

Implement the session orchestrator against that interface, per [execution.md](../specs/execution.md) and [frontend.md](../specs/frontend.md): launch one container per session, apply the sandbox profile (fixed CPU and memory quotas, read-only filesystem with a writable scratch directory, no network in this stage; the internal gateway-only network arrives in Stage 8 for LLM-enabled sessions), mount the recordings volume, supervise the container, and tear it down when the session ends, the episode terminates, the environment time limits expire, or the idle timeout fires. Enforce one concurrent session per user; the user identity is a stub until Stage 4 brings OAuth.

Define the transport between container and backend (proposal: the harness speaks newline-delimited JSON over the container's stdio or a local socket, carrying per-step states out and inputs in) and the WebSocket protocol between backend and browser (state objects out; human inputs and, from Stage 7, chat messages in). Implement the session loop from [interaction.md](../specs/interaction.md): the harness ticks realtime environments at the metadata tick rate, takes the latest input per tick for human-controlled slots or a noop, and steps turn-based environments as actions arrive. The backend stays a relay; the container is authoritative. Session start accepts a human-slot timeout override, defaults it from environment metadata, and passes the resolved value into the harness. This stage only needs Flappy Bird's single controllable slot, but the protocol should carry slot IDs so later multi-human sessions do not need a new transport.

Expose the minimal HTTP API the frontend will need: list environments with their public metadata, start a session, attach to a session's WebSocket, list and fetch recordings.

## Spec references

[execution.md](../specs/execution.md) (container model, sandboxing, languages, transport contract), [interaction.md](../specs/interaction.md) (session loop, human input), [frontend.md](../specs/frontend.md) (on-demand live play limits), [recording.md](../specs/recording.md) (shared volume).

## Depends on

Stage 1 (types from schema), Stage 2 (harness, base image contents).

## Done when

A scripted WebSocket test client starts a session, receives schema-valid states at the environment's tick rate, sends flap inputs that visibly affect the game, and the recording appears on the shared volume when the session ends. A second test starts a human-controlled session with a short human-slot timeout and verifies that missing input resolves to noop while the session keeps moving. A container that exceeds its memory quota or runs past the idle timeout is killed and reported cleanly. The container demonstrably has no network access. No module outside the local Docker driver references Docker APIs, verified by a lint rule or dependency check, so the Kubernetes driver remains a pure addition.

## Deviations

None yet.
