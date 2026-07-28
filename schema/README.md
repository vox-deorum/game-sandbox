# schema/

The contract for live state and recording headers. The Python harness, TypeScript backend, frontend renderer, transport, and recordings all answer to it.

The source of truth is the zod definitions under `ts/src/schemas/`:

- `step-state.ts`: the per-step state object.
- `recording-header.ts`: the recording header (line 1 of every recording).

The two JSON Schema draft 2020-12 files beside this README are generated from them:

- `step-state.schema.json`
- `recording-header.schema.json`

Do not edit the JSON by hand. Edit the zod source, then regenerate from the repository root:

```console
uv run python scripts/generate.py
```

The generator emits the JSON Schema first, then refreshes everything derived from it:

- packaged Python schema copies under `harness/`
- `schema/fixtures/`
- environment packaging and backend environment metadata

The `generated-code-fresh` CI job regenerates and diffs these paths, so committed output cannot drift from the zod source.

## Why the JSON is generated rather than authored

One definition serves both languages. TypeScript consumers take their types from `z.infer` and their runtime validation from the same schema object, so a type and its validator cannot disagree. The Python harness keeps validating with `jsonschema` against the generated copy, which is why the JSON Schema remains a committed artifact.

Two consequences are worth knowing when reading the generated files:

- Keys are sorted and the layout is uniform, because the emitter deep-sorts before writing. That keeps the committed bytes stable regardless of the order zod happens to walk a schema in.
- A few keywords zod has no direct spelling for (`uniqueItems`, `minProperties`) are attached with `.meta({ ... })` in the zod source and pass through to the emitted JSON unchanged.

`ts/` is the `@game-sandbox/schema` npm workspace. See [State schema](../docs/contributors/data/state-schema.md) for version and sidecar rules.
