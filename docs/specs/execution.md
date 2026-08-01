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
- One container holds the harness, environment, and an agent instance for every agent-controlled player in one session. Human players are external bindings.
- The backend supervises and relays. It does not step the game.
- The per-step state schema is the container boundary and recording format.

Keeping every player in one session container avoids crossing a second container boundary during each turn or tick. It also makes session management practical for a class-sized deployment.

Participant hooks run sequentially on the harness thread, including within a simultaneous tick. Before that tick's first hook, the harness snapshots every active player's observation and info mapping. Canonical player order determines hook order, but each decision sees its own snapshot from the same pre-step world. Simultaneous stepping therefore promises a joint environment transition, not concurrent CPU execution.

## Live sessions

The backend launches a container, relays state objects to browsers over WebSocket, and forwards authorized commands to the harness. The harness steps the environment, calls agent-controlled players, accepts actions for human bindings, and routes messages. The container lasts for the session.

When LLM access is enabled, the session gets a private network path that can reach only the backend LLM proxy. Before a session exits, it stops accepting new requests under its temporary LLM grants. It then aborts or finishes authenticated requests and waits for their accounting to settle. Only then may telemetry cleanup, network removal, and session completion proceed. See [LLM API for Agents](llm.md).

Every container launch includes a complete resolved `parameters` object. The harness validates it against the selected environment before constructing the environment, and the factory receives the normalized map. Live watch and play launches use the values submitted by the season-aware start form. Automated games use the parameter snapshot frozen when the run was created.

## Execution drivers

The backend uses an execution-driver interface to:

- Build or fetch an image.
- Launch it with a driver-neutral sandbox profile.
- Exchange ordered text lines.
- Observe exit status.
- Tear the process down.

Local Docker is the first driver. A future Kubernetes driver can map the same interface to its platform. Code above the driver does not depend on Docker-specific ports, file descriptors, or image-cache behavior. [Deployment](deployment.md) defines where the backend process itself runs relative to the daemon.

## From submission to image

The backend keeps one base image per template dependency version. Each base contains:

- The harness.
- PettingZoo.
- The environments.
- The exact dependency set for that version.

A single-agent submission image adds one pinned repository to the base. A multi-agent session image adds every participating submission in separate locations so repositories with the same module name do not conflict. Each submission is staged once per seat. Builds install no new dependencies. Every submission in a session uses the season's dependency version, so the shared base already contains everything it needs. [Environments](environment.md#players-and-seats) defines the per-player instances for a seat.

Builtin agents are staged by environment and stable name at `/opt/agents/builtin/<environment>/<name>`. A launch binding names the builtin that drives the player, and the harness resolves that two-level path when no explicit path is present. Every environment ships `naive`, and every builtin declared in environment metadata must have a matching staged directory in the dependency image.

Before use, the image passes the sandboxed load check from [Submissions](submission.md). Failed builds and checks are reported to the owner and never run in a game.

## Sandboxing

Session containers have:

- A fixed CPU quota and a memory quota that scales with player count.
- A read-only root filesystem.
- A bounded writable scratch directory.
- No general internet access, so an agent cannot outsource decisions or reach an unmetered service.
- Access only to the backend's internal LLM proxy when enabled, which is budgeted and logged.

Container memory and the automated-match watchdog scale with player count rather than seat count, because a wide seat may load one agent instance per player and each agent-controlled player has its own episode budget. Live sessions use a fixed deployment-wide chargeable-duration limit. Verified LLM proxy time is excluded from that limit, as [LLM API](llm.md#determinism-and-timing) defines.

Agents in a multi-agent session share one container and may interfere with one another. The platform does not isolate participants from their opponents inside the same match.

## Local development

Contributors can run an environment locally through the same live runner and browser protocol as a production session. The local bridge starts a caller-supplied Python runner, serves the prebuilt local browser page, and binds only to `127.0.0.1`. It has no account shell, Docker dependency, or general-purpose routes.

```text
Local browser ⇄ loopback Python relay ⇄ live runner + environment + agents
                                             │
                                             └→ scratch recording
```

The local relay passes live protocol messages through unchanged. The live runner writes only the recording header and completed-step state objects to the scratch recording. The [opening presentation state](interaction.md#per-step-state-object) and final result envelope are not recording lines. The relay validates and forwards commands and remembers the accepted pause state. Whenever a browser connects, the relay provides the header, latest live state object, session status, and current pause state when applicable. The live runner remains authoritative for stepping, pacing, agent loading, timeouts, and recording.

Participants use this local browser loop through the template. They do not need the backend, containers, or a network connection.

## Implementation languages

| Side | Language | Responsibilities |
| --- | --- | --- |
| Inside container | Python | Harness, PettingZoo environments, participant agents |
| Outside production container | TypeScript on Node | Identity, submissions, storage, orchestration, production WebSocket relay, browser app, LLM forwarding, retries, error handling, metering, and telemetry |
| Local development | Python | Loopback-only relay and static local-page server, plus the same live runner used in a session |

The state object contract is a versioned JSON Schema. Python validates emitted payloads, while TypeScript types are generated from the same source.

## Future work: in-browser agents

Browser execution of pure-Python agents is deferred. It would require a second runtime and run untrusted code in another user's browser. It will not produce official leaderboard scores.
