# Stage 1: Code Generation, Validation, and the Recording Store

Part of [Stage 1](../stage-01-contracts.md). This file covers how each language consumes the schema from [state-schema.md](state-schema.md) and how recordings are written and read, per [recording.md](../../docs/specs/recording.md).

## TypeScript: generated types plus Ajv guards

`json-schema-to-typescript` generates type declarations into `schema/ts/src/generated/types.ts`. The file is checked in and carries a fixed banner comment. The tool version is pinned so output is deterministic. Runtime validation uses Ajv's `Ajv2020` class, the canonical draft 2020-12 validator for JavaScript, compiled once per process.

The package exports typed guards and parsers rather than raw validators. `parseStepState(json: unknown): StepState` throws on invalid input and otherwise narrows through Ajv's validate-function type guard. `readRecording(lines)` parses the header line, enforces version equality between header and lines, skips unknown sidecar entries per the documented rule, and yields typed states. This is why the round-trip test runs with no hand-written casts: the guard does the narrowing.

Alternatives considered. `json-schema-to-zod` would give types and validation in one artifact, but its draft 2020-12 fidelity is weaker and it pulls Zod into the eventual frontend bundle. Ajv tracks the spec exactly. quicktype produces less controllable output for checked-in code.

## Python: direct jsonschema validation

Python validates with the `jsonschema` library's `Draft202012Validator`, running directly against the canonical schema files rather than against generated Pydantic models. The schema is the single source of truth, and a validator that consumes it directly has zero drift by construction.

Generated Pydantic was considered and rejected. `datamodel-code-generator` covers draft 2020-12 incompletely. The open `overlay` region, plus the untyped `observation` and `action` fields, defeat strict models anyway, degrading everything to `extra="allow"` and `Any`. A generated model that silently diverges from the schema is worse than no model.

Construction ergonomics come from a small hand-written layer of TypedDicts and builder functions in the harness package, which Stage 2 builds on. Validators are compiled once per process. If per-step validation ever shows up in a profile, `fastjsonschema` can replace the implementation behind the same function signatures without touching callers.

## Distributing the schema to the Python package

The canonical files live only in `schema/`. The generate script copies them into `harness/src/game_sandbox_harness/schema_data/` as package data, in the same run that regenerates the TypeScript types. This way editable dev installs, built wheels inside session containers, and CI all read identical bytes. One script produces three outputs: TypeScript types, packaged schema copies, and the golden fixtures described in [testing-and-ci.md](testing-and-ci.md).

## Staleness check

CI runs `uv run python scripts/generate.py` and then `git diff --exit-code` over the three generated locations: `schema/ts/src/generated/`, `harness/src/game_sandbox_harness/schema_data/`, and `schema/fixtures/`. Any schema change that was not regenerated fails the build, with the diff in the log. This is the check the stage's exit criteria call for, generalized from TypeScript types to everything generated.

## The harness package and the recording store

```
harness/
  pyproject.toml                         package name game-sandbox-harness
  src/game_sandbox_harness/
    __init__.py
    schema.py                            loads packaged schema, compiled validators,
                                         validate_step(), validate_header()
    state.py                             TypedDicts and builders for StepState and the header
    schema_data/                         generated copies of the canonical schema
    recording/
      __init__.py                        RecordingStore protocol, Recording, RecordingWriter
      local.py                           FolderRecordingStore
  tests/
```

`RecordingStore` is a `typing.Protocol` with three members:

- `create(recording_id, header)` returns a `RecordingWriter` context manager. Its `write_step(state)` validates the state, appends one JSONL line, and flushes on every write, so a crashed session leaves a readable prefix.
- `open(recording_id)` returns a `Recording` holding the parsed, validated header and a lazy iterator of validated states.
- `list_ids()` enumerates stored recordings.

`FolderRecordingStore(root)` lays out one directory per recording, `<root>/<id>/recording.jsonl`, with sidecars at their header-declared relative paths inside that directory. The per-recording directory is the S3 seam: it maps one to one onto an object-key prefix. The protocol has no filesystem types in its signatures (ids and streams only), so an `S3RecordingStore` later is purely additive, exactly as [recording.md](../../docs/specs/recording.md) requires.
