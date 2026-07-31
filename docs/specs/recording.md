# Recording and Replay

Recordings store state rather than video. A replay draws the stored state objects with the same renderer used for live play. It never runs the environment again.

The format is JSON Lines, or JSONL: one JSON object per line. The first line is the header and each later line is one state object.

```text
Header
  schema version, environment, seed, players, seats, seat plan, parameters
State object 1
State object 2
...
```

This design means:

- Recordings stay small.
- Renderer improvements apply to old compatible recordings.
- Schema versions prevent incompatible payloads from failing silently.
- Replays can pause, step, scrub, and expose structured data.

Replays are linkable by URL.

## Header

The header identifies who controlled each player: a human, a named builtin agent, or a submitted agent. A submitted-agent entry carries `submission_id` and no `builtin_name`. A builtin-agent entry carries `builtin_name` and no `submission_id`. Both agent variants carry the display label snapshotted at launch, so a replay needs no environment or season lookup to name a builtin. An agent entry with both identity fields or neither is invalid.

The header also records which players belonged to each seat, so a replay reads the grouping from the recording instead of re-deriving it from metadata that may have changed since. The player attribution within one seat may be mixed: a wide human seat records the person on its designated player and the selected companion agent on every other member. Every recording carries this seat map and the canonical seat-plan key, along with the complete normalized gameplay parameter map used to construct the environment. See [Environments](environment.md#configurable-gameplay-parameters).

## State objects

Each completed environment transition produces one [state object](interaction.md#per-step-state-object). PettingZoo [dead-step](interaction.md#session-loop) housekeeping produces no state object. A player that becomes inactive remains absent from later states. The player's final cumulative score is therefore the latest score recorded for that player anywhere in the recording, not necessarily a value in the final state.

Chat is stored in the state for each step, as [Communication](communication.md) defines. The JSONL file contains only the header and state objects. A recording keeps durable links to its successful LLM calls, while the [LLM API](llm.md#successful-call-accounting) defines their telemetry, retention, and visibility.

A naturally completed session or automated match ends its replay with the final-standings card, ranked by seat. The termination reason comes from the live session; an automated match has no user-facing live-session row, so it stores the reason directly. A stopped, timed-out, or crashed run shows no final standings. See [Frontend](frontend.md) for how a replay presents results.

## Retention

Every session is recorded. Storage remains bounded:

- Leaderboard recordings remain while their season is viewable.
- Live-session recordings remain for a deployment-configured window, 30 days by default.
- Each user has a recording quota.
- The oldest unpinned recordings are evicted first.
- Pinned recordings are protected from eviction but still count toward the quota.

## Storage

The harness serializes each recording header and completed-step state once, then sends the canonical line to recording storage and the backend relay. Storage retains that canonical line. A live session may also relay the unrecorded opening presentation state defined in [Interaction](interaction.md#per-step-state-object). When a state contains targeted chat, the relay sends each client an audience-filtered derived line and never delivers the targeted content to another live audience. Input, pause, resume, stop, and chat commands use separate event envelopes and do not become recording lines.

The first storage implementation uses a mounted folder. An S3-compatible implementation may be added behind the same save/load interface.
