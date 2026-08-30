# Stage 4: Live Session Control

Status: complete.

Part of [Stage 4](../stage-04-frontend-core.md). This file records the live half of the frontend: starting play and watch sessions from the environment page, the session page that hosts a renderer over the live socket, and the two session-level controls from [interaction.md](../../docs/specs/interaction.md): the human-slot timeout and pause. It builds on the clients, identity, and renderer contract from [frontend-infrastructure.md](frontend-infrastructure.md), and drives the Stage 3 API and WebSocket protocol unchanged except where noted.

## Starting a session

The environment page's two entry points map to the Stage 3 modes:

- **Play** starts a `human` session. The connected user takes the environment's human slot, Flappy Bird's `player_0`; the slot-based session model already generalizes per [frontend.md](../../docs/specs/frontend.md).
- **Watch** starts a `scripted` session, where the built-in agent plays and the user only observes.

Both go through a small start form with an optional seed for reproducible runs; the human-slot timeout control appears for human play only. The form calls `POST /api/sessions` and navigates to `/sessions/:id`. A 403 means not allowlisted (the entry points are already hidden, but the backend is the enforcement). A 409 carries the active session's id. The form closes and the UI shows a standalone confirmation with `[X]`, `[ Start new ]`, and `[ Return ]`: `X` abandons the pending start, Return navigates to the active session, and Start new terminates the active session, waits for termination, retries the exact pending request, and navigates on success. While replacing, the confirmation cannot dismiss or fire another action. Failures remain visible and retryable, and another conflict requires another explicit click.

## The session page

`/sessions/:id` fetches the session row (env, mode, status, recording id). If the row has already ended, the page stays in terminal mode, reads the produced recording for final score and tick metadata, and does not open a WebSocket. Otherwise it connects the socket client and mounts the environment's renderer from the registry when the header arrives. That is immediate, since attach replays the buffered header, the latest state, and the current status per [stage-03/transport-and-live-runner.md](../stage-03/transport-and-live-runner.md). From there:

- Every recording line goes to `render(state)`.
- `pause`/`resume` echoes drive the paused indicator.
- The `session` envelope drives the status banner.
- The `result` envelope ends the page in the end-of-session card.

Socket drops reconnect transparently while the session is active, since the attach replay makes that stateless; a "reconnecting" banner shows meanwhile. Once a terminal `session` frame arrives, the socket is intentionally closed and does not reconnect.

The page derives its capabilities from identity and mode rather than separate flags:

- The owner of a `human` session gets `controlledSlots` = the metadata's `human_slots` and a live `sendAction`.
- The owner of a `scripted` session gets controls but no input.
- Anyone else opening the URL is a spectator: same renderer, no controls. This is the protocol's existing authority rule (commands are accepted only from the owner) reflected in the UI.

Host chrome follows the contract's chrome split and works identically for every future environment: the status banner, the pause/resume toggle, the stop button, the active-timeout display, and the end-of-session card. Stop is sent in-band as the `stop` command over the socket, the graceful path the container honors; the `DELETE /api/sessions/:id` route remains the out-of-band fallback. The end-of-session card shows the result envelope's facts: final score, ticks, termination reason: plus the link to `/replays/:recordingId` and the post-session feedback stub from [replay-and-retention.md](replay-and-retention.md), which for now only offers pinning.

## The human-slot timeout control

One control, no second mechanism, per the parent file and [interaction.md](../../docs/specs/interaction.md). The deadline's meaning splits on the pace interval, and the control follows:

- **Paced environment (Flappy Bird).** The per-step deadline _is_ the pace interval: a step with no input gets the noop. The start form states this, and the play UI shows the resolved deadline as the per-step input window (50 ms / 20 steps per second) whenever the user controls a slot, which is the "show the active timeout when it can affect the session" requirement.
- **Unpaced environment (a later turn-based game).** The same control is the move clock: the form prefills the metadata's `human_timeout_ms`, the user may override it, and the play UI shows the resolved move time limit for the acting slot.

In both cases the form sends any entered override as `human_slot_timeout_ms` on session start. The Stage 3 API already accepts, resolves, and forwards it into the harness config, which satisfies the stage's override exit criterion today even though Flappy Bird's paced loop never consults the value. Nothing here is Flappy Bird-specific: when the first turn-based environment arrives, the control and display work from its metadata with no new mechanism.

## Pause

The pause toggle sends the `pause`/`resume` command envelopes. The container's `PausableClock` freezes the cadence and the decision clock together (built in Stage 3), and the echoes broadcast to every attached socket drive a paused overlay on owner and spectators alike. The UI never tracks pause state locally; it reflects the echo, so it cannot disagree with the container. For single-slot Flappy Bird this is a plain pause, but the control is already wired through the session, so it generalizes to later environments unchanged.

One interaction must stay honest in the UI. A paused-and-forgotten session still idles out: the Stage 3 idle timeout deliberately covers it: ending with reason `idle_timeout`. The status banner and end card must present that as a normal outcome, not an error. The idle window's definition and default were left tunable pending this stage's playtesting; whatever this stage confirms is recorded back into [stage-03/orchestrator-and-http-api.md](../stage-03/orchestrator-and-http-api.md) per the [plan rules](../README.md).
