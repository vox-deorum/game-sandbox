# Execution Architecture

Execution is split between two places. Rendering and human input always live in the browser (see [interaction.md](interaction.md)). Everything else, the environment stepping and the agents themselves, runs on the server.

## Always the same

- Rendering and human input always live in the browser. See [interaction.md](interaction.md).
- The environment and its step transitions always come from PettingZoo, with Shimmy wrapping any single-agent game. See [environment.md](environment.md).
- Every live session and every leaderboard match runs inside a single Docker container that holds the session harness, the environment, and all agent slots (see [leaderboard.md](leaderboard.md)). One container per session keeps orchestration simple, keeps participant code off other people's machines, and means no per-tick communication ever crosses a container boundary. Since agents step sequentially, they never legitimately compete for the container's CPU.

## Live sessions

A live session connects the browser to the backend over WebSocket. The backend launches one session container, relays each per-step state object from it to the renderer, and feeds human input back into the human slot (see [interaction.md](interaction.md) for the session loop). Inside the container, the harness steps the environment and queries each non-human slot's agent in turn. The container lives for the duration of the session.

## Sandboxing

Session containers are locked down. They run with no network access, fixed CPU and memory quotas, and a read-only filesystem except for a scratch directory. No network also closes a cheating vector: an agent cannot phone an external API or model to choose its actions.

Agents in a multi-agent session share the container, so a malicious agent could in principle read or interfere with its opponent. We accept that trade at class scale: submissions are pinned commits, so the operator can review the code before it runs, and every leaderboard run is recorded for inspection afterwards (see [recording.md](recording.md)).

## Local development

Developers of the sandbox itself run the same stack locally, Docker backend included. Participants do not need the stack at all; they develop and test their agents against vanilla PettingZoo using the template repos (see [submission.md](submission.md)).

## Future work: in-browser agents

Running a pure-Python agent directly in the viewer's browser through Pyodide would make casual play cheaper and lower latency, since no session container is launched on the server. The idea is deferred. It adds a second runtime target and a per-submission dependency-compatibility check, and above all it is a sandboxing problem: untrusted participant code would execute inside other users' browser sessions. If it comes back, it comes back behind real isolation, and it is never used to compute an official leaderboard score.

## Open questions

- How aggressively to cache built per-submission images between sessions to reduce session cold-start latency.
