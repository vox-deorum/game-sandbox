# Stage 3: The Session Orchestrator and the HTTP API

Part of [Stage 3](../stage-03-backend-and-live-sessions.md). The orchestrator owns the session lifecycle above the driver interface, per [execution.md](../../docs/specs/execution.md) and [frontend.md](../../docs/specs/frontend.md). The HTTP API is the minimal surface the Stage 4 frontend needs, with the WebSocket endpoint as the live attach point. The orchestrator depends only on the driver interface, the storage interface, and config, so its tests run on a fake driver with no Docker anywhere, per [testing-ci-and-docs.md](testing-ci-and-docs.md).

Status: implemented as described. The relay and the idempotent finalize live in `backend/src/session/live-session.ts`, the start/attach/stop wiring in `backend/src/session/orchestrator.ts`, and the routes in `backend/src/app.ts`. A few things were confirmed during the build:

- The kill grace is a fixed `KILL_GRACE_MS`; the driver escalates a polite stop to a hard kill over it.
- The session config's slot set is derived from the environment metadata. Each `human_slot` is `external` in human mode and `builtin-agent` in scripted mode, and any non-human slot is always the built-in agent.
- The idle timer is suppressed while a scripted watch session has a socket attached. A human session's window instead resets on each attach and inbound command.

## Starting a session

The start flow in `session/orchestrator.ts` runs these steps:

- Resolve the user (identity stub).
- Enforce one active session per user, via the in-memory registry backed by the `sessions` table; a second start is a 409.
- Validate the env id against the generated metadata.
- Validate the mode: `human` requires a human-capable slot, and `scripted` binds the built-in agent for watch-style runs.
- Resolve the overrides. The human-slot timeout comes from the request when given, else the metadata default, with the resolved value passed into the harness config. The seed comes from the request when given, else from `crypto`.
- Call `ensureImage({kind: 'session-base', depsVersion: 1})` (the current set version; Stage 5 resolves it per submission).
- Allocate the recording id (`<env>-<session id>`).
- Insert the sessions row as `starting`.
- Call `launch` with the session-config argv and the sandbox profile from config defaults: fixed CPU and memory quotas, read-only root, the scratch tmpfs, `network: 'none'`, and the recordings volume mounted at `/recordings`.

When the container's header line arrives, the session is `running`.

## The relay

A per-session relay task consumes `SessionProcess.output`:

- Recording lines are buffered (header plus latest state) and broadcast verbatim to every attached socket.
- The `result` envelope is relayed and stashed for the sessions row.
- `diagnostics` lines go to the backend logger, tagged with the session id.

Validated inbound commands go to `SessionProcess.send`, and `pause`/`resume` are echoed to all attached sockets. The backend interprets nothing else: it is a relay, and the container is authoritative.

Backpressure is a guardrail, not a hot path. States are small and Flappy-paced, but a socket whose `bufferedAmount` stays above a threshold is dropped, rather than letting one slow client balloon memory or stall the relay.

## Teardown

Every end path converges on one idempotent finalize routine: kill the process if still alive, drain the streams, update the row (`ended`, reason, `ended_at`), notify attached sockets with a `session` envelope, close them, and clear the registry entry. The paths are:

- **Container ends itself**: episode termination, environment time limits (the in-container budgets from Stage 2), or a client `stop` command. The reason comes from the `result` envelope (`terminated`, `truncated`, `episode_limit`, `stopped`).
- **Idle timeout**: for this stage, a session is idle when no WebSocket is attached, or when it is human-mode and no inbound command has arrived, continuously for `SESSION_IDLE_TIMEOUT_MS`. That covers the never-attached session, the abandoned tab, and the paused-and-forgotten session alike. On idle the orchestrator sends `stop`, waits the grace period, then kills, with reason `idle_timeout`. The exact window is config, and the definition may be tuned during Stage 4 playtesting.
- **Wall-clock backstop**: `SESSION_MAX_DURATION_MS` catches a hung container that in-container budgets cannot, since a truly stuck agent stalls the loop, per stage-02's timeout notes. The orchestrator kills, with reason `time_limit`.
- **Quota kill or crash**: `exited` reports `oomKilled` or a nonzero code without a `result`, so the reason is `oom_killed` or `error`. It is reported cleanly in the row and to attached clients, which is the parent's exit criterion for a memory hog.

## The HTTP API

Fastify routes under `/api`, request bodies validated with Fastify's JSON-schema support:

- `GET /api/environments`: the generated metadata list, verbatim.
- `POST /api/sessions`: `{env_id, mode, seed?, human_slot_timeout_ms?}` → 201 with the session id and WebSocket path; 409 when the user already has an active session; 400 for an unknown environment or an invalid mode/override.
- `GET /api/sessions/:id`: the session row: status, reason, recording id.
- `DELETE /api/sessions/:id`: graceful stop, owner only.
- `GET /api/sessions/:id/ws`: the WebSocket upgrade via `@fastify/websocket`; attaches to the live session per the protocol in [transport-and-live-runner.md](transport-and-live-runner.md). Multiple sockets per session are allowed (spectating); commands are accepted only from the session owner, and `input` only in human mode.
- `GET /api/recordings` and `GET /api/recordings/:id`: list ids and headers from the `FolderRecordingStore` layout on the recordings root, and stream a recording's JSONL. Retention, quotas, and pinning are Stage 4 concerns per [frontend.md](../../docs/specs/frontend.md); this stage lists and fetches only.
