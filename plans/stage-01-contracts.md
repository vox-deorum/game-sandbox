# Stage 1: Contracts and Repo Skeleton

Status: not started

## Goal

Establish the shapes everything else is built against: the repository layout, the versioned per-step state schema shared by Python and TypeScript, the recording file format, and the versioning rules later sidecars use. At the end of this stage there is no game yet, but both sides of the container boundary can produce and consume the same payloads.

## Scope

Set up the monorepo. Proposed layout, to be confirmed when the stage starts:

- `schema/` holds the versioned JSON Schema for the per-step state object and the recording header.
- `harness/` is the Python package: session harness, agent interface, environment registry (filled in from Stage 2).
- `environments/` holds environment wrappers and their public-facing metadata (filled in from Stage 2).
- `backend/` is the Node/TypeScript server (filled in from Stage 3).
- `frontend/` is the web app, including the per-environment renderers (filled in from Stage 4).
- `templates/` is the source of the participant template repo (filled in from Stage 2).
- `gateway/` holds LLM gateway deployment configuration (filled in from Stage 7).

Define the per-step state object as a JSON Schema (draft 2020-12) with an explicit schema version field, covering the fields named in [interaction.md](../specs/interaction.md): tick number, per-agent display observations, actions, rewards, cumulative scores, environment-specific overlay fields, messages, and timing. Messages and overlay fields are present in the schema from day one even though messaging arrives in Stage 9, so the schema does not need a breaking revision later.

Wire up code generation and validation: TypeScript types derived from the schema (json-schema-to-typescript or equivalent) as a build step in `backend/` and `frontend/`, and runtime validation in Python (jsonschema or Pydantic models generated from the same source) that the harness applies to every payload it emits, per [execution.md](../specs/execution.md).

Define the recording format from [recording.md](../specs/recording.md) as JSONL: a header line naming the environment and the schema version, followed by one per-step state per line. This is the same line-delimited JSON the harness streams over its transport in Stage 3, so the wire form and the stored form are a single format. The header also defines how optional sidecars attach to a recording, without defining any sidecar payloads yet. The LLM telemetry sidecar arrives in Stage 7 and uses the same schema versioning rule, so adding it is an additive contract change rather than a second storage format. Implement a minimal Python save and load interface against a folder on disk, designed so an S3-compatible backend can be added behind it later.

Add baseline tooling: linting, formatting, and test runners for both languages, and a CI check that fails when generated TypeScript types are stale relative to the schema.

## Spec references

[execution.md](../specs/execution.md) (the schema as the cross-boundary contract, implementation languages), [interaction.md](../specs/interaction.md) (per-step state object), [recording.md](../specs/recording.md) (header, format, and sidecar placement).

## Depends on

Nothing. This is the first stage.

## Done when

A round-trip test passes in CI: Python constructs a per-step state object and a two-step recording, validates them against the schema, writes them to disk, and TypeScript reads them back through the generated types with no hand-written casts. Bumping the schema version in a test fixture is detected by both sides, and a fixture with an unknown optional sidecar is ignored according to the documented rule rather than corrupting the recording.

## Deviations

None yet.
