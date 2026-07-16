# For Contributors

This section explains how to develop Game Sandbox. Read the [specification](../specs/README.md) for product rules and the [implementation plan](https://github.com/vox-deorum/game-sandbox/blob/main/plans/README.md) for stage status.

## System map

```text
Vue frontend ⇄ Node backend ⇄ Python session container
                    │                    └─ environment + agents
                    ├─ SQLite metadata
                    └─ recording files
```

The language split follows the container boundary: Python runs inside sessions, while TypeScript runs the backend and browser app.

| Directory | What it is |
| --- | --- |
| `schema/` | The canonical JSON Schema contract and the `@game-sandbox/schema` TS package. |
| `harness/` | The Python harness: schema validation, state builders, the recording store, the session loop. |
| `environments/` | Environment packages: the single-agent adapter and the Flappy Bird clone. |
| `backend/` | The Node/TypeScript backend: sessions, the execution driver, the WebSocket bridge, and the metered LLM proxy. |
| `frontend/` | The browser frontend: Vue with Vite, the renderers, and the Better Auth session client. |
| `templates/` | The student starter kit: an env-agnostic `base/` layer plus one `<env>/` layer per environment. |
| `examples/` | Example overlays under `<env>/<name>/`, holding only their diff against the composed template. |
| `docs/` | This site. |
| `scripts/` | Cross-platform Python dev scripts. |

## Choose a guide

| Task | Guide |
| --- | --- |
| Set up the repository | [Development setup](development-setup.md) |
| Configure the server, authentication, sandbox, and retention | [Configuration](configuration.md) |
| Choose and run checks | [Testing](test.md) |
| Write or run browser end-to-end tests | [End-to-end tests](e2e-tests.md) |
| Change wire or recording data | [State schema](state-schema.md), then [Recordings](recordings.md) |
| Add a game | [Adding an environment](environments.md), then [Rendering](rendering.md) |
| Change the student starter kit | [Examples and template](examples-and-template.md) |
| Work on HTTP, storage, submissions, seasons | [Backend](backend.md) |
| Work on containers, transport, or session lifecycle | [Execution boundary](execution.md) |
| Work on pages or browser behavior | [Frontend](frontend.md) |
| Change visual patterns or components | [Design system](design.md) |
