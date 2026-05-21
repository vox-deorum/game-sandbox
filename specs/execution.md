# Execution Architecture

Execution is layered. The system is not a single fixed choice between "everything in the browser" and "everything on the server". Different parts run in different places by design.

## Always the same

- Rendering and human input always live in the browser. See [interaction.md](interaction.md).
- The environment and its step transitions always come from PettingZoo, with Shimmy wrapping any single-agent game. See [environment.md](environment.md).
- Leaderboard runs (see [leaderboard.md](leaderboard.md)) always execute on Docker, for reproducibility and for sandboxing participant code.

## Deployment modes

- **Local deployment.** The web frontend runs on a developer or participant machine, renders an environment, and accepts human input. This is meant for debugging an environment or trying a partially built agent without any remote infrastructure. Agents in this mode run locally, either in the same Python process as the environment or in Pyodide for pure-Python agents.
- **Hosted website, Docker-backed agents.** The deployed frontend connects to a Docker backend. Each non-human slot in a session is fulfilled by an agent container. WebSocket carries state to the browser and input back. This is the default path for live play and the only path used for leaderboard runs.
- **Hosted website, Pyodide-backed agents.** Same frontend, but if an agent's declared dependencies are all available in Pyodide, the agent loads and runs directly in the user's browser. No backend container is allocated for that slot. This path is cheaper and lower latency, and it works well for traditional algorithm submissions that do not need heavy native dependencies. It is opt-in per submission and is never used to compute an official leaderboard score.

## Mixed sessions

A single session can mix execution locations across slots. For example, a session might have a human in the browser at slot 0, a Pyodide agent in the same browser at slot 1, and a Docker-backed agent on the server at slot 2.

## Routing rule for where an agent runs

1. If the session is a leaderboard run, the agent runs on Docker.
2. Otherwise, if the agent declares Pyodide-compatible dependencies, the frontend may run it in Pyodide.
3. Otherwise, the agent runs in a Docker container.

## Open questions

- How aggressively to cache agent containers between back-to-back live sessions to reduce cold-start latency.
