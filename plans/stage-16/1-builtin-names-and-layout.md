# Stage 16.1: Builtin names and layout annotation

Status: not started.

Part of [Stage 16](../stage-16-pinned-seats.md), build-order step 1.

## Outcome

Environment metadata names its builtin agents and can fix a seat to one of them. Every environment declares exactly the reserved `naive` builtin, no seat is annotated yet, and the registry JSON, the TypeScript mirror, and the shape guards all carry the new fields, so the platform's behavior is unchanged while the vocabulary exists end to end.

## Metadata

`EnvironmentMeta` gains `builtin_agents`, an ordered tuple of entries with a snake_case `name` and a display `label`. Validation requires `naive` as the first entry, unique names, and at least one entry. The existing single staged builtin is what `naive` resolves to, and `DEFAULT_BUILTIN_AGENT_BASE` resolution in `live.py` is untouched this stage.

`SeatPlan` gains an optional per-seat `fixed` annotation naming a declared builtin, parallel in shape to the seat tuple. Validation rejects an annotation naming an undeclared builtin, and rejects the annotation entirely under player bounds, which have no distinguished seats. `resolve_layout` carries the annotation into `ResolvedSeat` so downstream consumers read one resolved shape.

## Serialization and mirrors

- `to_json()` and `_layout_to_json` in `harness/src/game_sandbox_harness/environment.py` emit the new fields; the registry JSON regenerates.
- `schema/ts/src/environment.ts` mirrors both fields, extends `isEnvironmentLayout` and its `hasOnlyKeys` allow-lists, and carries the annotation through `resolveLayout` and `ResolvedSeat`.
- `environments/test_conformance.py` keeps the metadata JSON round-trip test honest over the new fields.

## Specification

[Environments](../../docs/specs/environment.md) gains the named-builtins declaration and the fixed-controller seat annotation, stated as capability in metadata with assignment left to the season config.

## Tests

- Python validation: missing `naive`, duplicate names, unknown fixed name, and a fixed annotation under player bounds each fail with a typed error naming the problem.
- TypeScript guard tests for the extended shapes, plus `uv run python scripts/ci.py generated-code-fresh`.
