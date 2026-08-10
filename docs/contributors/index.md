# For Contributors

This section explains how to develop Game Sandbox. Read the [specification](../specs/index.md) for product rules and the [implementation plan](https://github.com/vox-deorum/game-sandbox/blob/main/plans/README.md) for stage status.

## System map

```text
Vue frontend ⇄ Node backend ⇄ Python session container
                    │                    └─ environment + agents
                    ├─ SQLite metadata
                    └─ recording files
```

## Core concepts

- **Environment**: a game or task exposed through the PettingZoo interface.
- **Agent**: a submitted or built-in program that controls one or more environment players.
- **Session**: a sandboxed container that runs one environment and its agent-controlled players.
- **Submission**: a participant's GitHub repository, pinned to a commit and tagged with a season.
- **Recording**: the saved per-step state of a session, kept for replay.
- **Template**: the composed, runnable repository a student receives, combining shared base files with an environment's layer.
- **Harness**: [the process inside the session container that steps the environment, drives every agent-controlled player, and emits the per-step state](../specs/overview.md).
- **Season and workflow run**: a season is one competition round for an environment; a workflow run is an automated batch of matches scheduled to update its leaderboard.

The repository is laid out as follows:

| Directory | What it is |
| --- | --- |
| `schema/` | The canonical JSON Schema contract and the `@game-sandbox/schema` TypeScript package ([README](https://github.com/vox-deorum/game-sandbox/blob/main/schema/README.md)). |
| `harness/` | The Python harness: schema validation, state builders, the recording store, and the session loop. |
| `environments/` | Environment packages, renderers, hand-authored template layers, and worked examples ([README](https://github.com/vox-deorum/game-sandbox/blob/main/environments/README.md)). |
| `backend/` | The Node/TypeScript backend: sessions, the execution driver, the WebSocket relay, and the metered LLM proxy ([README](https://github.com/vox-deorum/game-sandbox/blob/main/backend/README.md)). |
| `frontend/` | The browser frontend: Vue with Vite, the renderers, and the Better Auth session client ([README](https://github.com/vox-deorum/game-sandbox/blob/main/frontend/README.md)). |
| `templates/` | The environment-agnostic student base layer. |
| `docs/` | This site. |
| `scripts/` | Cross-platform Python dev scripts. |

## Choose a guide

| Task | Guide |
| --- | --- |
| Set up the repository | [Development setup](setup/development.md) |
| Configure the server, authentication, sandbox, and retention | [Configuration](setup/configuration.md) |
| Choose and run checks | [Testing](testing/index.md) |
| Write or run browser end-to-end tests | [Browser end-to-end tests](testing/browser-e2e.md) |
| Locate runtime, test, or demo data | [Data folders](data/folders.md) |
| Change wire or recording data | [State schema](data/state-schema.md), then [Recordings](data/recordings.md) |
| Add an environment | [Adding an environment](environments/index.md), then [Rendering](environments/rendering.md) |
| Change the template | [Template product and releases](environments/templates.md) |
| Work on HTTP, storage, submissions, or seasons | [Backend](runtime/backend.md) |
| Work on containers, transport, or session lifecycle | [Execution boundary](runtime/execution.md) |
| Work on pages or browser behavior | [Frontend development](frontend/development.md) |
| Change visual patterns or components | [Design system](frontend/design-system.md) |
