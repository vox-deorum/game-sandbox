# schema/

The JSON Schema contract for live state and recording headers. The Python harness, TypeScript backend, frontend renderer, transport, and recordings use these schemas.

Two JSON Schema draft 2020-12 files are the source of truth:

- `step-state.schema.json`: the per-step state object.
- `recording-header.schema.json`: the recording header (line 1 of every recording).

Edit these files, then regenerate from the repository root:

```console
uv run python scripts/generate.py
```

The generator refreshes its derived artifacts, including:

- `ts/src/generated/types.ts`
- packaged Python schema copies
- `schema/fixtures/`
- environment packaging and backend environment metadata

`ts/` is the `@game-sandbox/schema` npm workspace. See [State schema](../docs/contributors/data/state-schema.md) for version and sidecar rules.
