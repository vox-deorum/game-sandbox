# Recording and Replay

Recordings store state, not video. A replay draws stored states with the same renderer used for live play. It never re-simulates the environment.

```text
Header
  environment, schema version, seed, players, sidecars
State line 1
State line 2
...
```

The header identifies who controlled each slot, either a human, the built-in agent, or a submitted agent.

This design means:

- Recordings stay small.
- Renderer improvements apply to old compatible recordings.
- Schema versions prevent incompatible payloads from failing silently.
- Replays can pause, step, scrub, and expose structured data.

Replays are linkable by URL.

Chat is stored in per-step state. LLM telemetry is a sidecar keyed by tick and slot. See [Communication](communication.md) and [LLM API](llm.md).

## Retention

Every session is recorded. Storage remains bounded:

- Leaderboard recordings remain while their season is viewable.
- Live-session recordings remain for a deployment-configured window, 30 days by default.
- Each user has a recording quota.
- The oldest unpinned recordings are evicted first.
- Pinned recordings are protected from eviction but still count toward the quota.

## Storage

The format is JSON Lines, or JSONL: one JSON object per line. The first line is the header and each later line is one step.

The harness writes the same serialized state bytes to storage and the live transport. Input, pause, resume, stop, and chat commands use separate event envelopes and are not recording lines.

The first storage implementation uses a mounted folder. An S3-compatible implementation may be added behind the same save/load interface.
