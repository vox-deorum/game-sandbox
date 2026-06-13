# For Contributors

This section is for people developing Game Sandbox itself. It explains how to set the repository up, how the cross-boundary contract behaves in practice, and how the example and template publishing pipeline works. Where a topic is about design rather than operation, it links to the [Specification](../../specs/overview.md) instead of restating it.

## The monorepo map

The language split follows the container boundary (see the [execution spec](../../specs/execution.md)): everything inside a session container is Python, everything outside is TypeScript on Node.

| Directory | What it is |
| --- | --- |
| `schema/` | The canonical JSON Schema contract and the `@game-sandbox/schema` TS package. |
| `harness/` | The Python harness: schema validation, state builders, the recording store, the session loop. |
| `environments/` | Environment packages: the single-agent adapter and the Flappy Bird clone. |
| `backend/` | The Node/TypeScript backend: sessions, the execution driver, and the WebSocket bridge. |
| `frontend/` | The browser frontend: Vue with Vite, the renderers, and the mock-identity layer. |
| `gateway/` | The LLM gateway. Placeholder until Stage 7. |
| `templates/` | The student starter kit: an env-agnostic `base/` layer plus one `<env>/` layer per environment. |
| `examples/` | Example overlays under `<env>/<name>/`, holding only their diff against the composed template. |
| `docs/` | This site. |
| `scripts/` | Cross-platform Python dev scripts. |

## Where to read next

- [Development setup](development-setup.md): tools, scripts, running checks and tests, Windows and WSL notes.
- [Testing end to end](test.md): the full local suite, reproducing the workflows with `act`, and what only GitHub can test.
- [State schema](state-schema.md): the contract, the version rule, and the sidecar rule.
- [Recordings](recordings.md): the JSONL format, the header, the store interface.
- [Adding an environment](environments.md): the adapter, the registry entry, metadata, and the overlay contract.
- [Examples and the template](examples-and-template.md): overlays, tags, and publishing.
- [The backend](backend.md): the package layout, configuration, storage, the identity stub, and the HTTP API.
- [The execution boundary](execution.md): the driver interface, the sandbox profile, the transport, the WebSocket protocol, and the live runner.
- [The frontend](frontend.md): the package layout, the dev server, the mock identity, and the live and replay hosts.
- [Rendering](rendering.md): the renderer contract, the PixiJS base class, the sizing-and-scaling model, and how to add a renderer for a new environment.

The full build plan lives in the [implementation plan](https://github.com/vox-deorum/game-sandbox/blob/main/plans/README.md), and the authoritative design lives in the [Specification](../../specs/overview.md).
