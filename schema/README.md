# schema/

The canonical contract between the Python harness and the TypeScript backend and renderer. Two JSON Schema files (draft 2020-12) are the single source of truth:

- `step-state.schema.json`: the per-step state object.
- `recording-header.schema.json`: the recording header (line 1 of every recording).

These files are the only place either is edited. Everything else is generated from them by `scripts/generate.py`:

- `ts/src/generated/types.ts`: TypeScript declarations.
- `../harness/src/game_sandbox_harness/schema_data/`: byte-identical copies packaged with the Python harness.
- `fixtures/`: golden recordings, written by Python through the real recording store and read back by the TypeScript test suite.

The version rule and the sidecar rule are documented for contributors and students on the docs site under [contributors/state-schema.md](../docs/contributors/state-schema.md). This README is only a pointer; the docs page is the normative home.

`ts/` is the npm workspace package `@game-sandbox/schema`.
