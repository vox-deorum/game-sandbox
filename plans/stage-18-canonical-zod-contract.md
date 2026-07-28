# Stage 18: The canonical zod contract

Status: in progress.

## Goal

One authored definition per wire contract. A shape is declared once as a zod schema, its TypeScript type comes from `z.infer`, its runtime validation comes from the same schema object, and the JSON Schema the Python harness validates against is generated from it.

This is platform work rather than a product feature. Nothing a participant or an operator sees changes.

## Scope

- The state and recording-header contracts move to zod. `schema/*.schema.json` becomes generated output, and `schema/ts/src/generated/types.ts` is deleted in favor of `z.infer`.
- `AgentRef` and the stored agent columns move to one zod codec, and the agent key gets one shared definition.
- The three Fastify JSON Schema route literals in `backend/src/app.ts` become in-handler zod validation, matching what every other validated route in the backend already does.
- The launch config's flat attribution and binding bags become the disjoint unions the recording schema already describes.
- Environment metadata gains a canonical zod schema and a generated JSON Schema, with a Python conformance check beside the existing dataclass validation.
- Three findings from the Stage 16.1 review land with it: the shared agent key, the built-in label on the board wire, and the two attribution fallbacks.

Out of scope: converting the parameter resolution engine in `schema/ts/src/environment.ts`, which validates runtime values against runtime-supplied declarations rather than a fixed shape.

## Related specifications

None. This stage changes how contracts are expressed, not what they say. [Recording](../docs/specs/recording.md) and [Environments](../docs/specs/environment.md) continue to describe the same rules.

## Dependencies

- [Stage 1](stage-01-contracts.md): the state schema, the generated types, and the recording format.
- [Stage 16](stage-16-named-builtins.md): the named-builtin identity this stage consolidates.

## Implementation decisions

### zod stays out of the browser bundle

Every subpath-exported module in `schema/ts` except the barrel is dependency-free so Vite can bundle it. That rule holds because all 17 frontend imports from the barrel are `import type` and take only `RecordingHeader` and `StepState`, which erase at build time. The frontend takes every runtime value from the dependency-free subpaths.

Two guards were the exception. `isEnvironmentMeta` was called at runtime in `frontend/src/api/client.ts` and moves to the zod side, with the frontend dropping the call: the catalog is the backend's own response, already validated at startup by `EnvironmentRegistry.parse`, and the frontend trusts the backend everywhere else. `classifyOutbound` stays hand-written in `protocol.ts` because it runs per frame in both processes.

Physical separation enforces this, not tree-shaking. The package already split `protocol.ts` and `environment.ts` out of the Ajv-backed barrel for the same reason.

### The JSON Schema is generated and byte-stable

`schema/ts/scripts/emit-json-schema.ts` renders the zod schemas with `z.toJSONSchema`, injects the `$id` values, deep-sorts keys, and writes the canonical files. Sorting decouples the committed bytes from the order zod walks a schema in, so a zod upgrade that reorders traversal cannot flap the freshness check. `zod` is pinned to an exact version in `schema/ts/package.json` for the same reason, matching the existing pin on the type generator it replaces.

Keywords zod has no direct spelling for (`uniqueItems`, `minProperties`, and a tuple's `minItems`) are attached with `.meta({ ... })` and pass through unchanged.

`created_at` keeps `format: date-time` as an annotation rather than a validated pattern. The harness writes `datetime.isoformat()`, which carries a `+00:00` offset, and Python never attached a format checker, so the keyword documents the field without embedding a validator-specific regex in a generated artifact.

### Route bodies validate in the handler

Fastify's Ajv runs with `coerceTypes` and would rewrite a union value before the environment's own parameter validator saw it, which is why `parameters` was an opaque object in the route schema. Validating in the handler removes the coercion path rather than continuing to dodge it, and makes these three routes consistent with the rest of the backend.

### Python keeps its dataclass validation

`EnvironmentMeta.__post_init__` gives environment authors immediate, readable, `env_id`-specific errors at import time, which is the primary interface for the student-facing environment API. The generated schema becomes a conformance check beside it rather than a replacement. This narrows the two-language duplication to one generated contract that both sides are checked against; it does not remove the Python validator.

Cross-field rules do not survive emission. Uniqueness, the reserved-parameter match, a `restricted_builtin` naming a declared agent, and the seat-plan partition are `.refine()` checks that JSON Schema cannot express, so they stay enforced by the zod parse and by `__post_init__`. `harness/tests/test_schema.py` names the fixture cases that fall into that bucket rather than leaving the gap implicit.

Every object in the metadata schema is strict. `z.toJSONSchema` emits `additionalProperties: false` for a plain `z.object()` as well as a strict one, because JSON Schema cannot express zod's strip behavior. A permissive object would therefore accept an unknown field in TypeScript while Python rejected the same payload, which is the drift this stage exists to remove.

## Exit criteria

- `schema/*.schema.json` is generated from zod, and regenerating twice from a clean tree is a no-op.
- The golden fixtures under `schema/fixtures/` are byte-identical across the change, proving the Python harness reads and writes the same recordings.
- `schema/ts/src/generated/types.ts` is gone and no workspace references it.
- No module with a subpath export in `schema/ts/package.json` imports zod as a runtime value, and a frontend build contains no zod.
- One `AgentRef` schema backs the guard, the stored-column codec, and both stored-seat decoders. One exported `agentRefKey` replaces the five spellings of the same key.
- The three route bodies validate through zod, and every request shape the old JSON Schema rejected is still rejected.
- Boards show a built-in's declared label rather than its snake_case name.
- `uv run python scripts/ci.py python`, `typescript`, `generated-code-fresh`, and `docs` pass.
