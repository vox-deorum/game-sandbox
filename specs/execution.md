# Execution Architecture

Execution is split between two places. Rendering and human input always live in the browser (see [interaction.md](interaction.md)). Everything else, the environment stepping and the agents themselves, runs on the server.

## Always the same

- Rendering and human input always live in the browser. See [interaction.md](interaction.md).
- The environment and its step transitions always come from PettingZoo, with Shimmy wrapping any single-agent game. See [environment.md](environment.md).
- Every live session and every leaderboard match runs inside a single Docker container that holds the session harness, the environment, and all agent slots (see [leaderboard.md](leaderboard.md)). One container per session keeps orchestration simple, keeps participant code off other people's machines, and means no per-tick communication ever crosses a container boundary. Since agents step sequentially, they never legitimately compete for the container's CPU.

## Live sessions

A live session connects the browser to the backend over WebSocket. The backend launches one session container, relays each per-step state object from it to the renderer, and feeds human input back into the human slot (see [interaction.md](interaction.md) for the session loop). Inside the container, the harness steps the environment and queries each non-human slot's agent in turn. The harness also relays chat messages between slots and over the WebSocket to the human player and spectators (see [communication.md](communication.md)). The container lives for the duration of the session.

## From submission to image

The backend turns submissions into the image a session container runs. It starts from a common base image that already holds the harness, PettingZoo, and the environments, clones each participating submission's repo at its pinned commit, and installs the dependencies named in each manifest (see [submission.md](submission.md)) on top. A single-agent session layers one submission; a multi-agent session layers every participant's requirements into the same image, since all slots share the container. Leaderboard matches run the same way (see [leaderboard.md](leaderboard.md)). A submission whose build fails is reported to its owner rather than run.

## Sandboxing

Session containers are locked down. They run with fixed CPU and memory quotas and a read-only filesystem except for a scratch directory. The only network a container can reach is an internal one whose single endpoint is the LLM gateway (see [llm.md](llm.md)); there is no general internet access. The original concern behind blocking the network was cheating, an agent secretly phoning an outside service to choose its actions. That concern survives in an updated form: arbitrary network access stays blocked, and the model calls an agent can make go through the gateway, where they are sanctioned, equal for every participant, metered, and fully logged.

Agents in a multi-agent session share the container, so a malicious agent could in principle read or interfere with its opponent. We accept that trade at class scale: submissions are pinned commits, so the operator can review the code before it runs, and every leaderboard run is recorded for inspection afterwards (see [recording.md](recording.md)).

## Local development

Developers of the sandbox itself run the same stack locally, Docker backend included. Participants do not need the stack at all; they develop and test their agents against vanilla PettingZoo using the template repos (see [submission.md](submission.md)).

## Implementation languages

The language split follows the container boundary. Everything inside the session container is Python: the harness loads participant agents in-process alongside PettingZoo, so there is no real alternative. Everything outside is TypeScript on Node: GitHub OAuth, submissions, leaderboard storage, replay serving, the browser-facing WebSocket endpoint, and the Docker orchestration that launches and supervises session containers, all sharing native types and tooling with the browser renderer. The one allowed exception is the LLM gateway, which may be an off-the-shelf proxy such as LiteLLM running as its own service rather than being reimplemented in TypeScript (see [llm.md](llm.md)).

The per-step state object is the contract across that boundary. It is defined once as a versioned JSON Schema; the TypeScript backend and renderer derive their types from it, and the Python harness validates the payloads it emits against it. This is the same schema version that recordings carry in their header (see [recording.md](recording.md)), so there is a single source of truth for the wire format and the stored format alike.

## Future work: in-browser agents

Running a pure-Python agent directly in the viewer's browser through Pyodide would make casual play cheaper and lower latency, since no session container is launched on the server. The idea is deferred. It adds a second runtime target and a per-submission dependency-compatibility check, and above all it is a sandboxing problem: untrusted participant code would execute inside other users' browser sessions. If it comes back, it comes back behind real isolation, and it is never used to compute an official leaderboard score.

## Open questions

- How aggressively to cache built per-submission images between sessions to reduce session cold-start latency.
- What to do when two submissions in the same multi-agent session pin conflicting dependency versions. At class scale a failed build with a clear error message may be acceptable; per-slot processes with isolated environments would solve it properly but would reshape the in-process harness.
