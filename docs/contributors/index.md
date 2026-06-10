# For Contributors

This section is for people developing Game Sandbox itself. It explains how to set the repository up, how the cross-boundary contract behaves in practice, and how the example and template publishing pipeline works. Where a topic is about design rather than operation, it links to the [Specification](../specs/overview.md) instead of restating it.

## The monorepo map

The language split follows the container boundary (see the [execution spec](../specs/execution.md)): everything inside a session container is Python, everything outside is TypeScript on Node.

| Directory | What it is |
| --- | --- |
| `schema/` | The canonical JSON Schema contract and the `@game-sandbox/schema` TS package. |
| `harness/` | The Python harness: schema validation, state builders, the recording store. |
| `environments/` | Environment packages. Placeholder until Stage 2. |
| `backend/` | The Node/TypeScript backend. Placeholder until Stage 3. |
| `frontend/` | The browser frontend and renderers. Placeholder until Stage 4. |
| `gateway/` | The LLM gateway. Placeholder until Stage 7. |
| `templates/` | The student starter kit (placeholder content until Stage 2). |
| `examples/` | Example overlays holding only their diff against `templates/`. |
| `docs/` | This site. |
| `scripts/` | Cross-platform Python dev scripts. |

## Where to read next

- [Development setup](development-setup.md): tools, scripts, running checks and tests, Windows and WSL notes.
- [State schema](state-schema.md): the contract, the version rule, and the sidecar rule.
- [Recordings](recordings.md): the JSONL format, the header, the store interface.
- [Examples and the template](examples-and-template.md): overlays, tags, and publishing.

The full build plan lives in the [implementation plan](https://github.com/vox-deorum/game-sandbox/blob/main/plans/README.md), and the authoritative design lives in the [Specification](../specs/overview.md).
