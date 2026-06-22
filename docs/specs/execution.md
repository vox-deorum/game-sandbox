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

A submission image adds the pinned repository to the base without installing new dependencies. Every submission in a session uses the season's dependency version.

Before use, the image passes the sandboxed load check from [Submissions](submission.md). Failed builds and checks are reported to the owner and never run in a game.

## Sandboxing

Session containers have:

- Fixed CPU and memory quotas.
- A read-only root filesystem.
- A bounded writable scratch directory.
- No general internet access.
- Access only to the internal LLM gateway when enabled.

General network access stays blocked so an agent cannot secretly outsource decisions or contact an unmetered service. Model use through the gateway is an explicit exception because it is shared, budgeted, and logged.

Agents in a multi-agent session share one container and could interfere with one another. This class-scale tradeoff is accepted because submissions are pinned and reviewable, and every official run is recorded.

## Local development

Contributors run the full stack locally. Participants use the template and do not need the backend or container stack.

## Implementation languages

| Side | Language | Responsibilities |
| --- | --- | --- |
| Inside container | Python | Harness, PettingZoo environments, participant agents |
| Outside container | TypeScript on Node | Identity, submissions, storage, orchestration, WebSocket relay, browser app |
| Separate service | Implementation-defined | OpenAI-compatible LLM gateway |

The state contract is a versioned JSON Schema. Python validates emitted payloads, while TypeScript types are generated from the same source.

## Future work: in-browser agents

Running pure-Python agents in the browser could reduce latency and container use for casual play. It is deferred because it adds a second runtime and per-submission compatibility checks, and it would execute untrusted code in another user's browser. Browser execution will not produce official leaderboard scores.
