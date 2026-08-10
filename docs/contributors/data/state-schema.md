# The State Schema

The per-step state is the contract between Python, TypeScript, live transport, and replay:

```text
zod schemas → TypeScript types and validation
            → JSON Schema → Python validation
                          → live state lines
                          → recording state lines
```

The zod definitions under `schema/ts/src/schemas/` are the source. They render to JSON Schema draft 2020-12 under `schema/`, which is what the Python [harness](../../specs/overview.md) validates against. This page defines versioning and sidecar compatibility. See [Execution](../runtime/execution.md) and [Recordings](recordings.md).

## The two definitions

- `schema/ts/src/schemas/step-state.ts` defines the state at one step: `schema_version`, `tick`, per-agent observations, actions, rewards and cumulative scores, an open `overlay` for environment-specific fields, optional `messages`, optional `chat_options`, and `timing`. Field names use snake case because it is natural in Python and conventional in JSON. The TypeScript types come from `z.infer`, so they keep the same names.
- `schema/ts/src/schemas/recording-header.ts` defines the recording header: `schema_version`, `environment`, the normalized gameplay `parameters` map, optional `seed`, `created_at`, and `overlay_static` fields, the `sidecars` array, and the required `players`, `seats`, and `seat_plan` fields. `overlay_static` holds immutable environment-specific renderer data captured after reset. `players` assigns each player id to one of three closed variants: a human, a submitted agent carrying `submission_id`, or a builtin agent carrying `builtin_name`. An agent entry with both identity fields or neither is invalid. `seats` forms an exact nonempty partition of those player ids, and `seat_plan` records the canonical plan key. The header stays open while each attribution entry stays closed, so a reader may ignore an optional header field it does not recognize.

Running `scripts/generate.py` re-emits `schema/step-state.schema.json` and `schema/recording-header.schema.json` from these definitions. Do not edit that JSON by hand.

Closed regions use `additionalProperties: false` so validation catches accidental changes. `overlay` is the designated open extension for environment-specific display data.

`messages` and `overlay` exist in the initial schema even before every capability uses them. Reserving those extension points avoids a breaking schema revision when messaging or another renderer payload becomes active.

## The version rule

`schema_version` is an integer that changes only for a breaking change:

- Removing or renaming a field.
- Changing a field type.
- Changing a field's meaning.

Adding an optional field or sidecar does not require a new version.

A reader built for version N accepts exactly version N and reports a clear error for any other version. At the first real bump, retain old schemas under versioned directories.

> _What does the pre-release checkout support today?_ Only recordings with the complete required header. The schema version remains 1 because earlier recording files are recreated instead of read.

The version appears in the header and every state. The header governs the stream, while the per-state copy keeps an isolated frame self-describing. Readers enforce equality.

## The sidecar rule

A sidecar is an auxiliary file declared by `name` and recording-relative `path`. A reader that does not recognize the name skips it and continues loading the recording.

Sidecars use the recording header's schema version. Adding a new sidecar kind is additive, not a second recording format.
