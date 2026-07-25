# Recording and Replay

Recordings store state rather than video. A replay draws the stored states with the same renderer used for live play. It never runs the environment again.

```text
Header
  environment, schema version, seed, players, seats, sidecars
State line 1
State line 2
...
```

The header identifies who controlled each player, either a human, the built-in agent, or a submitted agent. It also records which players belonged to each seat, so a replay reads the grouping from the recording instead of re-deriving it from metadata that may have changed since. The player attribution within one seat may be mixed: a wide human seat records the person on its designated player and the selected companion agent on every other member. Every supported recording carries this seat map, the derived player count, and the canonical seat-plan key. Finally it records the complete normalized gameplay parameter map used to construct the environment. Only the reserved parameter that matched the environment's declaration was editable when the game started.

This design means:

- Recordings stay small.
- Renderer improvements apply to old compatible recordings.
- Schema versions prevent incompatible payloads from failing silently.
- Replays can pause, step, scrub, and expose structured data.

Replays are linkable by URL.

When a run finishes play, its final replay frame shows the same final-standings card as the end of a live session. The card ranks seats by score, and each row leads with the seat's controller attribution and names the players it covered. A mixed human seat shows both the human and companion. The termination reason determines whether the run finished play. A recording produced by a session gets this reason from that session. An automated season run has no session, so its recording stores the reason directly. A stopped, timed-out, or crashed run shows no final standings.

Chat is stored in the state for each step. Successful LLM calls made by agents produce telemetry in backend-managed SQLite, keyed by execution scope, tick, and player. The session or leaderboard run that produced a recording keeps durable scope and session links to the relevant telemetry rows. The recording's JSONL still contains only its header and state lines.

Student development calls are metered separately and never appear in recording telemetry. A recording with no LLM association had no calls. If its associated execution scope was retained but cannot be read, the telemetry is unavailable rather than empty.

Public replays keep model, token, and budget-cost metadata after the controlling submission is deleted. Only operators may inspect the stored request and completion bodies after deletion. External telemetry is retained as long as a retained recording refers to it. See [Communication](communication.md) and [LLM API](llm.md).

## Retention

Every session is recorded. Storage remains bounded:

- Leaderboard recordings remain while their season is viewable.
- Live-session recordings remain for a deployment-configured window, 30 days by default.
- Each user has a recording quota.
- The oldest unpinned recordings are evicted first.
- Pinned recordings are protected from eviction but still count toward the quota.

## Storage

The format is JSON Lines, or JSONL: one JSON object per line. The first line is the header and each later line is one step.

The harness writes the same serialized state bytes to both storage and the live transport. Input, pause, resume, stop, and chat commands use separate event envelopes and do not become recording lines.

The first storage implementation uses a mounted folder. An S3-compatible implementation may be added behind the same save/load interface.
