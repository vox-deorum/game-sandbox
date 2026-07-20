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
- One container holds the harness, environment, and every agent slot for one session.
- The backend supervises and relays. It does not step the game.
- The per-step state schema is the container boundary and recording format.

Keeping every slot in one session container avoids a second container boundary inside the per-turn loop and keeps orchestration practical at class scale. Agents act sequentially, so legitimate agent work does not require simultaneous CPU access.

## Live sessions

The backend launches a container, relays state to browsers over WebSocket, and forwards authorized commands to the harness. The harness steps the environment, calls agent slots, and routes messages. The container lasts for the session.

When LLM access is enabled, the session uses a private per-session network path whose only reachable service is the backend LLM proxy. Session exit first closes its temporary LLM grants to new admission, then aborts or drains authenticated requests and waits for their accounting to settle. Telemetry cleanup, network removal, and lifecycle completion happen only after that barrier. See [LLM API for Agents](llm.md).

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

A single-agent submission image adds the one pinned repository to the base. A multi-agent session image instead overlays every participating submission, each isolated in its own location so repositories that happen to share a module name do not collide. No build installs new dependencies: every submission in a session uses the season's dependency version, so the shared base already carries everything they need.

Before use, the image passes the sandboxed load check from [Submissions](submission.md). Failed builds and checks are reported to the owner and never run in a game.

## Sandboxing

Session containers have:

- Fixed CPU and memory quotas.
- A read-only root filesystem.
- A bounded writable scratch directory.
- No general internet access.
- Access only to the backend's internal LLM proxy when enabled.

General network access stays blocked so an agent cannot secretly outsource decisions or contact an unmetered service. Model use through the backend proxy is an explicit exception because successful calls are shared, budgeted, and logged.

Agents in a multi-agent session share one container and could interfere with one another. This class-scale tradeoff is accepted because submissions are pinned and reviewable, and every official run is recorded.

## Local development

Contributors run the full stack locally. Participants use the template and do not need the backend or container stack.

## Implementation languages

| Side | Language | Responsibilities |
| --- | --- | --- |
| Inside container | Python | Harness, PettingZoo environments, participant agents |
| Outside container | TypeScript on Node | Identity, submissions, storage, orchestration, WebSocket relay, browser app, LLM forwarding, retries, error handling, metering, and telemetry |

The state contract is a versioned JSON Schema. Python validates emitted payloads, while TypeScript types are generated from the same source.

## Future work: in-browser agents

Running pure-Python agents in the browser could reduce latency and container use for casual play. It is deferred because it adds a second runtime and per-submission compatibility checks, and it would execute untrusted code in another user's browser. Browser execution will not produce official leaderboard scores.
