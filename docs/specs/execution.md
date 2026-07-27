# Execution Architecture

Rendering and human input run in the browser. Environment stepping and agents run on the server.

```text
Browser                    Backend                  Session container
renderer + input ⇄ WebSocket relay ⇄ line transport ⇄ harness + environment + agents
                                                        │
                                                        └→ recording volume
```

## Invariants

- The browser owns rendering and human input.
- PettingZoo owns environment transitions.
- One container holds the harness, environment, and an agent instance for every player in one session.
- The backend supervises and relays. It does not step the game.
- The per-step state schema is the container boundary and recording format.

Keeping every player in one session container avoids crossing a second container boundary during each turn. It also keeps session management practical for a class-sized deployment. Agents act in sequence, so legitimate agent work does not need simultaneous CPU access.

## Live sessions

The backend launches a container, relays state to browsers over WebSocket, and forwards authorized commands to the harness. The harness steps the environment, calls each player's agent, and routes messages. The container lasts for the session.

When LLM access is enabled, the session gets a private network path that can reach only the backend LLM proxy. Before a session exits, it stops accepting new requests under its temporary LLM grants. It then aborts or finishes authenticated requests and waits for their accounting to settle. Only then may telemetry cleanup, network removal, and session completion proceed. See [LLM API for Agents](llm.md).

Every container launch includes a complete resolved `parameters` object. The harness validates it against the selected environment before constructing the environment, and the factory receives the normalized map. Live watch and play launches use the values submitted by the season-aware start form. Automated games use the parameter snapshot frozen when the run was created.

## Execution drivers

The backend uses an execution-driver interface to:

- Build or fetch an image.
- Launch it with a driver-neutral sandbox profile.
- Exchange ordered text lines.
- Observe exit status.
- Tear the process down.

Local Docker is the first driver. A future Kubernetes driver can map the same interface to its platform. Code above the driver does not depend on Docker-specific ports, file descriptors, or image-cache behavior.

## From submission to image

The backend keeps one base image per template dependency version. Each base contains:

- The harness.
- PettingZoo.
- The environments.
- The exact dependency set for that version.

A single-agent submission image adds one pinned repository to the base. A multi-agent session image adds every participating submission, each in a separate location so repositories with the same module name do not conflict. Staging happens once per seat, so an agent assigned across several players contributes one pinned repository location. A submitted companion for a human seat uses that same seat location; [Environments](environment.md#players-and-seats) defines the per-player instances. Builds install no new dependencies. Every submission in a session uses the season's dependency version, so the shared base already contains everything it needs.

Before use, the image passes the sandboxed load check from [Submissions](submission.md). Failed builds and checks are reported to the owner and never run in a game.

## Sandboxing

Session containers have:

- Fixed CPU and memory quotas.
- A read-only root filesystem.
- A bounded writable scratch directory.
- No general internet access.
- Access only to the backend's internal LLM proxy when enabled.

Container memory and the session's wall-clock limit scale with the player count rather than the seat count, because a wide seat loads one agent instance per player and each player has its own episode budget.

General network access stays blocked so an agent cannot secretly outsource decisions or contact an unmetered service. The backend LLM proxy is the one exception because successful model calls are shared, budgeted, and logged.

Agents in a multi-agent session share one container and could interfere with one another. This class-scale tradeoff is accepted because submissions are pinned and reviewable, and every official run is recorded.

## Local development

Contributors can run an environment locally through the same live runner and browser protocol as a production session. The local bridge starts a Python runner supplied by the caller, serves the prebuilt local browser page, and binds only to `127.0.0.1`. It has no account or sign-in interface, Docker dependency, general-purpose server routes, or option to bind beyond the local machine.

```text
Local browser ⇄ loopback Python relay ⇄ live runner + environment + agents
                                             │
                                             └→ scratch recording
```

The local relay passes recording header, state, and result lines through unchanged. It validates and forwards commands and remembers the accepted pause state. Whenever a browser connects, the relay provides the header, latest state, session status, and current pause state when applicable. The live runner remains authoritative for stepping, pacing, agent loading, timeouts, and recording.

Participants use this local browser loop through the template. They do not need the backend, containers, or a network connection.

## Implementation languages

| Side | Language | Responsibilities |
| --- | --- | --- |
| Inside container | Python | Harness, PettingZoo environments, participant agents |
| Outside production container | TypeScript on Node | Identity, submissions, storage, orchestration, production WebSocket relay, browser app, LLM forwarding, retries, error handling, metering, and telemetry |
| Local development | Python | Loopback-only relay and static local-page server, plus the same live runner used in a session |

The state contract is a versioned JSON Schema. Python validates emitted payloads, while TypeScript types are generated from the same source.

## Future work: in-browser agents

Running pure-Python agents in the browser could reduce latency and container use for casual play. This work is deferred because it would add a second runtime, require compatibility checks for each submission, and run untrusted code in another user's browser. Browser execution will not produce official leaderboard scores.
