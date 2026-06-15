# Recording and Replay

Recordings are state only. A recording is the sequence of per-step states, actions, rewards, and timings produced during an episode, prefixed by a small header that names the environment, the version of its state schema, and the per-slot attribution: who or what drove each slot, either a connected human (annotated with the player) or an agent (the built-in Naive agent, or a submission owner's agent). A replay reads that attribution from the header to state who played. There are no video files. A replay re-renders the stored states through the same frontend renderer used during live play (see [interaction.md](interaction.md)); it does not re-simulate the episode.

Three things follow from this:

- Recordings stay small.
- The renderer can be improved without re-running any games. Old replays automatically pick up the improvements, and the schema version in the header keeps a changed payload format from silently breaking them.
- A replay is just a web page, not a passive video, so it can be paused, stepped, scrubbed, and inspected.

Replays are linkable by URL.

Chat messages are part of the per-step state object, so they are recorded and replayed like everything else (see [communication.md](communication.md)). LLM telemetry is stored as a sidecar next to the recording, keyed by tick and slot and covered by the same schema version (see [llm.md](llm.md)).

## What gets recorded

Every session is recorded automatically, leaderboard runs and live sessions alike (see [leaderboard.md](leaderboard.md) and [frontend.md](frontend.md)). Storage stays bounded through retention rather than opt-in. Leaderboard recordings are kept for as long as their iteration remains viewable. Live session recordings are kept for a deployment-configured window (30 days by default) under a per-user quota, evicting the oldest unpinned recordings first. A user can pin a replay to exempt it from eviction; pinned replays still count against the quota. Recordings are small by design, so the policy is generous at class scale.

## Storage

Recordings are written to a folder on disk behind a minimal save and load interface, as JSONL: the header on the first line, then one per-step state per line. This is the same line-delimited JSON the harness streams outward over its transport during a live session (see [execution.md](execution.md)), so the state wire form and the stored form are one format. Human input, pause and resume, and chat commands use their own command envelope and are not recording lines. Since the workflow runs in Docker, a shared volume mounted into the workflow container is enough. An S3-compatible object store can be added behind the same interface when a real deployment needs one; no other backends are planned.
