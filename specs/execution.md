# Execution Architecture

Execution is split between two places. Rendering and human input always live in the browser (see [interaction.md](interaction.md)). Everything else, the environment stepping and the agents themselves, runs on the server.

## Always the same

- Rendering and human input always live in the browser. See [interaction.md](interaction.md).
- The environment and its step transitions always come from PettingZoo, with Shimmy wrapping any single-agent game. See [environment.md](environment.md).
- Agents always run in Docker containers, both for live sessions and for leaderboard runs (see [leaderboard.md](leaderboard.md)). One runtime keeps the session orchestrator simple and keeps participant code off other people's machines.

## Live sessions

A live session connects the browser to the backend over WebSocket. The backend steps the environment, sends each per-step state object to the renderer, and feeds human input back into the human slot (see [interaction.md](interaction.md) for the session loop). Each non-human slot is fulfilled by an agent container allocated for the duration of the session.

## Sandboxing

Agent containers are locked down. They run with no network access, fixed CPU and memory quotas, and a read-only filesystem except for a scratch directory. No network also closes a cheating vector: an agent cannot phone an external API or model to choose its actions.

## Local development

Developers of the sandbox itself run the same stack locally, Docker backend included. Participants do not need the stack at all; they develop and test their agents against vanilla PettingZoo using the template repos (see [submission.md](submission.md)).

## Future work: in-browser agents

Running a pure-Python agent directly in the viewer's browser through Pyodide would make casual play cheaper and lower latency, since no container is allocated for that slot. The idea is deferred. It adds a second runtime target and a per-submission dependency-compatibility check, and above all it is a sandboxing problem: untrusted participant code would execute inside other users' browser sessions. If it comes back, it comes back behind real isolation, and it is never used to compute an official leaderboard score.

## Open questions

- How aggressively to cache agent containers between back-to-back live sessions to reduce cold-start latency.
