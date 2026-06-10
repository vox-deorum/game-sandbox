# Execution Architecture

Execution is split between two places. Rendering and human input always live in the browser (see [interaction.md](interaction.md)). Everything else, the environment stepping and the agents themselves, runs on the server.

## Always the same

- Rendering and human input always live in the browser. See [interaction.md](interaction.md).
- The environment and its step transitions always come from PettingZoo, with Shimmy wrapping any single-agent game. See [environment.md](environment.md).
- Every live session and every leaderboard match runs inside a single Docker container that holds the session harness, the environment, and all agent slots (see [leaderboard.md](leaderboard.md)). One container per session keeps orchestration simple, keeps participant code off other people's machines, and means no per-tick communication ever crosses a container boundary. Since agents step sequentially, they never legitimately compete for the container's CPU.

## Live sessions

A live session connects browsers to the backend over WebSocket. The backend launches one session container, relays each per-step state object from it to renderers, and feeds human input back into the human-controlled slots (see [interaction.md](interaction.md) for the session loop). Inside the container, the harness steps the environment and queries each non-human slot's agent in turn. The harness also relays chat messages between slots and over the WebSocket to human-controlled slots and spectators (see [communication.md](communication.md)). The container lives for the duration of the session.

## Execution drivers

The backend never talks to container infrastructure directly. It goes through a small execution driver interface: build or fetch an image, launch a session with a sandbox profile, stream its I/O, and tear it down. The first driver runs against local Docker, which is what development and class-scale deployments use. A Kubernetes driver is the planned second implementation for deployments that outgrow one host. Nothing above the driver may assume Docker specifics: the sandbox profile (quotas, read-only filesystem, network policy) is expressed in driver-neutral terms and each driver maps it onto its platform. How aggressively images are cached between sessions is configuration on the driver, not policy hardcoded above it. Where this spec says "Docker container", read "container on the configured driver"; local Docker is simply the driver we run today.

## From submission to image

Dependencies come from the template, not from individual repos (see [submission.md](submission.md)). The template's dependency set is versioned, and the backend keeps one base image per set version, holding the harness, PettingZoo, the environments, and that version of the set. Turning submissions into a session image is then a matter of cloning each participating repo at its pinned commit into its own per-slot directory on top of the right base; no per-submission dependency installation happens. Every submission in a session runs on the same set version (an iteration pins one, see [leaderboard.md](leaderboard.md)), so agents sharing a container cannot have conflicting dependencies, and a years-old submission can be rebuilt exactly by using the base image of the set version it was submitted against. A submission whose build fails is reported to its owner rather than run.

## Sandboxing

Session containers are locked down. They run with fixed CPU and memory quotas and a read-only filesystem except for a scratch directory. The only network a container can reach is an internal one whose single endpoint is the LLM gateway (see [llm.md](llm.md)); there is no general internet access. The original concern behind blocking the network was cheating, an agent secretly phoning an outside service to choose its actions. That concern survives in an updated form: arbitrary network access stays blocked, and the model calls an agent can make go through the gateway, where they are sanctioned, equal for every participant, metered, and fully logged.

Agents in a multi-agent session share the container, so a malicious agent could in principle read or interfere with its opponent. We accept that trade at class scale: submissions are pinned commits, so the operator can review the code before it runs, and every leaderboard run is recorded for inspection afterwards (see [recording.md](recording.md)).

## Local development

Developers of the sandbox itself run the same stack locally, Docker backend included. Participants do not need the stack at all; they develop and test their agents against vanilla PettingZoo using the template repos (see [submission.md](submission.md)).

## Implementation languages

The language split follows the container boundary. Everything inside the session container is Python: the harness loads participant agents in-process alongside PettingZoo, so there is no real alternative. Everything outside is TypeScript on Node: GitHub OAuth, submissions, leaderboard storage, replay serving, the browser-facing WebSocket endpoint, and the session orchestration that launches and supervises containers through the execution driver, all sharing native types and tooling with the browser renderer. The one allowed exception is the LLM gateway, which may be an off-the-shelf proxy such as LiteLLM running as its own service rather than being reimplemented in TypeScript (see [llm.md](llm.md)).

The per-step state object is the contract across that boundary. It is defined once as a versioned JSON Schema; the TypeScript backend and renderer derive their types from it, and the Python harness validates the payloads it emits against it. This is the same schema version that recordings carry in their header (see [recording.md](recording.md)), so there is a single source of truth for the wire format and the stored format alike.

## Future work: in-browser agents

Running a pure-Python agent directly in the viewer's browser through Pyodide would make casual play cheaper and lower latency, since no session container is launched on the server. The idea is deferred. It adds a second runtime target and a per-submission dependency-compatibility check, and above all it is a sandboxing problem: untrusted participant code would execute inside other users' browser sessions. If it comes back, it comes back behind real isolation, and it is never used to compute an official leaderboard score.
