# Recording and Replay

Recordings are state only. A recording is the sequence of per-step states, actions, rewards, and timings that is sufficient to deterministically replay the episode through the same frontend renderer used during live play (see [interaction.md](interaction.md)). There are no video files.

Three things follow from this:

- Recordings stay small.
- The renderer can be improved without re-running any games. Old replays automatically pick up the improvements.
- A replay is just a web page, not a passive video, so it can be paused, stepped, scrubbed, and inspected.

Replays are linkable by URL.

## Storage backends

The system supports two storage backends, chosen by configuration:

- An S3-compatible object store, for any deployment that has one available.
- A folder on disk. Since the workflow runs in Docker, a shared volume mounted into the workflow container is enough.

No other backends are supported unless a real deployment needs one.
