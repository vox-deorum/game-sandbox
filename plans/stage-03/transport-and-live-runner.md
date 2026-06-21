# Stage 3: Transport Protocols and the Live Session Runner

Part of [Stage 3](../stage-03-backend-and-live-sessions.md). This file defines the two protocol layers: container to backend, and backend to browser: and the Python live runner that implements the container side over the Stage 2 harness, per [interaction.md](../../docs/specs/interaction.md) and [recording.md](../../docs/specs/recording.md).

Status: implemented, both sides. The container side passes with the Stage 2 determinism fixtures unchanged as the regression gate; it comprises the `Episode` extraction in `session.py`, the `live` and `live_io` modules, and their pytest suites. The backend-to-browser WebSocket half landed with the orchestrator: the line classification and command envelopes, plus `backend/src/session/live-session.ts` for the relay (see [orchestrator-and-http-api.md](orchestrator-and-http-api.md)). Stage 4 hoisted the classification rule and the command envelopes into `@game-sandbox/schema` so the browser speaks the same contract from one declaration, and the relay imports them from there. Implementation specifics confirmed during the build are recorded inline below.

## Line classification: recording lines and envelopes

The outbound stream from the container is JSONL, and recording lines pass through unchanged so the wire form and the stored form stay one format. Two outbound line shapes exist:

- **Recording lines**: the header first, then one per-step state per line, exactly as `FolderRecordingStore` serializes them, schema-validated in the harness before emission.
- **Event envelopes**: any line whose top-level object has a `kind` field. This stage defines one outbound kind, `result`, emitted once at session end with the `EpisodeResult` fields (ticks, final scores, termination reason, overage counts, recording id). Envelope lines are never written to the recording.

The classification rule is that recording lines never carry a top-level `kind` property. It holds because the state schema defines no such field, and a test asserts that against the packaged schema so the rule cannot rot silently. The same rule classifies WebSocket frames.

Inbound command envelopes (backend to container, over the driver channel) carry a `kind`, a slot id where applicable, and a payload: `{"kind": "input", "slot": "player_0", "action": <action JSON>}`, `{"kind": "pause"}`, `{"kind": "resume"}`, and `{"kind": "stop"}` for graceful end. Stage 8 adds `{"kind": "chat", ...}` on the same envelope. Unknown kinds and malformed lines are logged to stderr and ignored: the container must never die because a client sent garbage.

## The WebSocket protocol

Backend to browser uses the same split, per the parent file. Server-to-client frames are JSON text:

- The header and state lines, relayed verbatim.
- The relayed `result` envelope.
- Relayed `pause`/`resume` echoes, so every attached client can show paused state.
- One backend-originated envelope, `{"kind": "session", "status": "running" | "ended", "reason"?}`.

On attach the backend sends the buffered header, the most recent state, and the current session status, so a renderer can draw immediately. Full catch-up and scrubbing belong to the Stage 4 replay viewer, not the live socket. Client-to-server frames are the same command envelope as the container side. The backend validates the envelope shape and that the sender controls the slot, then forwards; it never interprets actions, because the container is authoritative. Slot ids ride every input, so later multi-human sessions are protocol-compatible without a new transport.

## Exposing the step machinery

Pacing has to apply to every live session. A watch session with only the built-in agent must still advance at the environment's cadence, so pacing cannot hide inside a human action source. `session.py` is therefore refactored to expose the machinery `run_episode` already contains:

- An `Episode` object owning the reset state. Its methods are `start`, `step_once`, `done`, `stop`, `close`, and `result`, with a context-manager form pairing `start` and `close`.
- A `step_once()` that advances the acting slot: action acquisition, environment step, `learn`, state assembly, recording write, and budget accounting.
- The termination checks.

`run_episode` becomes a thin loop over `Episode` (`while not episode.done: episode.step_once()`) with byte-identical behavior; the Stage 2 determinism fixtures pass unchanged, which is the regression gate for the refactor. The live loop is a second thin loop over the same machinery. Before each step it waits until the next cadence instant when the environment has a pace interval, and does not wait when it has none, then checks the pause and stop flags, then calls `step_once()`. That conditional on the pace interval is the entire realtime-versus-turn-based difference, which is the "one code path reading the pace interval" the parent file requires.

Two implementation details fell out of the build:

- The cadence is gated even for the first step. The loop seeds the next instant at the current clock reading and advances it by the interval before each step, so the first state lands one interval in rather than immediately. That keeps pause uniform: a pause active at the loop boundary is handled by the same frozen-clock wait as a pause that arrives mid-cadence, with no special first-step case.
- Pause needs no explicit branch in the paced path. Because the injected `PausableClock` freezes, the cadence wait simply never reaches its instant while paused. A shared `while control.paused` wait sits ahead of the pace conditional purely so the turn-based path (whose source blocks on input, not on the clock) also refuses to step while paused. Both waits slice on the injected `Sleeper`, so a `stop` stays responsive.

## The live runner

New harness modules, present in the session base image:

```
harness/src/game_sandbox_harness/
  live.py     python -m game_sandbox_harness.live: config parsing (LiveConfig/parse_config),
              slot binding (build_slots), stdout hygiene, the paced live loop (run_live_loop)
  live_io.py  PausableClock; SessionControl (the latched inputs and pause/stop flags) and
              start_command_pump; TransportSource; ProtocolStream and build_tee_store;
              the Sleeper abstraction (RealSleeper); result_envelope
```

- **Session config** arrives as a single JSON argument in the container argv (via `LaunchSpec.args`): env id, seed, slot bindings (`external` or `builtin-agent` per slot), the resolved human-slot timeout, and the recording id and directory. The metadata defaults: pace interval, time limits, default human timeout: come from the registry inside the image, so the config carries only overrides and there is one source of truth for environment facts. Session start accepts the human-slot timeout override, defaults it from metadata, and the resolved value lands in the `ExternalSlot` timeout, which satisfies the parent's override requirement. Stdin is reserved for runtime commands.
- **Stdout hygiene.** Protocol lines must own stdout, but pygame prints a banner on import. The first thing `live.py` does is `os.dup()` the real stdout for the protocol writer and `os.dup2()` stderr over fd 1, before any game import. Stray prints from environment internals then land in the diagnostics stream instead of corrupting the protocol.
- **The command pump.** A reader thread consumes stdin lines and updates shared state: the latest input per slot (latching, per [interaction.md](../../docs/specs/interaction.md)), the pause flag, and the stop flag. The stepping thread never blocks on stdin.
- **`PausableClock`** wraps any `Clock` (including `ManualClock`, which keeps the pytest suites deterministic) and subtracts accumulated paused time from `now_ms()`. Injected as the episode clock, it freezes the decision clock and the cadence together. The spec'd pause semantics fall out with no special cases in the loop, because every duration in the system is a difference of two readings of this clock. Headless runs never construct a live loop, so they never pace and never pause.
- **`TransportSource`** implements `ActionSource` for external slots over the pump's latched state. With a pace interval, the deadline handed down is the cadence instant, and the source returns the latched input or `None` immediately. With no pace interval, it blocks (in short slices, so pause and stop stay responsive) until input arrives or the human-slot timeout expires. Either way `ExternalSlot`'s existing `None` fallback applies the environment default action: noop for Flappy Bird: with no agent-timeout accounting, exactly the Stage 2 machinery.
- **The tee store** mirrors every serialized line onto the protocol stream. Rather than a separate re-serializing wrapper, `FolderRecordingStore` grew an optional keyword-only `on_line` mirror hook. Its writer serializes each header and state line exactly once, writes it to the recording file on the mounted volume and flushes, then hands the same string to `on_line`. `build_tee_store(root, protocol)` wires that hook to the protocol's `emit_raw`, so the streamed bytes and the stored bytes are identical by construction; `test_live_io.py` asserts the parity byte-for-byte and that the stream carries no line the recording does not. Recording directories and files are chmodded after creation, so a root-owned, cap-dropped session container can leave files that the backend user can read and delete on the host bind mount. The default (`on_line=None`) leaves serialization and readback behavior unchanged, so the Stage 2 recording suites are untouched.
- **Built-in agent slots** load `/opt/agents/builtin` (overridable per slot in the config) through the Stage 2 manifest loader: the same path Stage 5 submissions take.
- **Lifecycle.** The runner ends on episode end (`terminated`, `truncated`, `episode_limit`) or the `stop` command (`REASON_STOPPED`, set on the episode via `Episode.stop` so the next loop check ends the run). It closes the recording, emits the `result` envelope (`{"kind": "result", ...}` carrying ticks, scores, reason, step_timeouts, recording_id), flushes, and exits 0. Uncaught errors log to stderr and exit nonzero, and the orchestrator records the failure. Per-step and per-episode budgets run unchanged inside the container; the wall-clock backstop against a hung container lives in the orchestrator, per [orchestrator-and-http-api.md](orchestrator-and-http-api.md).
