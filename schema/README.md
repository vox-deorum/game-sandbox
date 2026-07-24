# schema/

The canonical contract between the Python harness, TypeScript backend, frontend renderer, live transport, and recordings.

Two JSON Schema draft 2020-12 files are the source of truth:

- `step-state.schema.json`: the per-step state object.
- `recording-header.schema.json`: the recording header (line 1 of every recording).

Edit these files, then regenerate:

```console
uv run python scripts/generate.py
```

Generation updates:

- `ts/src/generated/types.ts`
- Python package schema copies
- Golden fixtures

`ts/` is the `@game-sandbox/schema` npm workspace. See [State schema](../docs/contributors/data/state-schema.md) for version and sidecar rules.
