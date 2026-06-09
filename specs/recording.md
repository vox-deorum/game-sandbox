# Recording and Replay

Recordings are state only. A recording is the sequence of per-step states, actions, rewards, and timings produced during an episode, prefixed by a small header that names the environment and the version of its state schema. There are no video files. A replay re-renders the stored states through the same frontend renderer used during live play (see [interaction.md](interaction.md)); it does not re-simulate the episode.

Three things follow from this:

- Recordings stay small.
- The renderer can be improved without re-running any games. Old replays automatically pick up the improvements, and the schema version in the header keeps a changed payload format from silently breaking them.
- A replay is just a web page, not a passive video, so it can be paused, stepped, scrubbed, and inspected.

Replays are linkable by URL.

## What gets recorded

Leaderboard runs are always recorded (see [leaderboard.md](leaderboard.md)). Live sessions are recorded only when the user chooses to save the replay at the end of the session, next to the feedback prompt (see [frontend.md](frontend.md)). Idle play therefore does not grow storage without bound.

## Storage

Recordings are written to a folder on disk behind a minimal save and load interface. Since the workflow runs in Docker, a shared volume mounted into the workflow container is enough. An S3-compatible object store can be added behind the same interface when a real deployment needs one; no other backends are planned.
