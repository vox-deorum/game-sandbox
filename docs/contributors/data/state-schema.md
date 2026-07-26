# The State Schema

The per-step state is the contract between Python, TypeScript, live transport, and replay:

```text
JSON Schema → Python validation
            → generated TypeScript types
            → live state lines
            → recording state lines
```

The source uses JSON Schema draft 2020-12 under `schema/`. This page defines versioning and sidecar compatibility. See [Execution](../runtime/execution.md) and [Recordings](recordings.md).

## The two files

- `schema/step-state.schema.json` defines the state at one step: `schema_version`, `tick`, per-agent observations, actions, rewards and cumulative scores, an open `overlay` for environment-specific fields, optional `messages`, and `timing`. Field names use snake case because it is natural in Python and conventional in JSON. The generated TypeScript types keep the same names.
- `schema/recording-header.schema.json` defines the recording header: `schema_version`, `environment`, optional `seed` and `created_at` fields, the `sidecars` array, and the required `players`, `seats`, and `seat_plan` fields. `players` assigns each player id to a human or agent with `{kind, label, user?, submission_id?}`. `seats` forms an exact nonempty partition of those player ids, and `seat_plan` records the canonical plan key. The header remains open (`additionalProperties: true`) while each attribution entry remains closed (`additionalProperties: false`). Running `scripts/generate.py` refreshes the TypeScript type.

Closed regions use `additionalProperties: false` so validation catches accidental changes. `overlay` is the designated open extension for environment-specific display data.

`messages` and `overlay` exist in the initial schema even before every capability uses them. Reserving those extension points avoids a breaking schema revision when messaging or another renderer payload becomes active.

## The version rule

`schema_version` is an integer that changes only for a breaking change:

- Removing or renaming a field.
- Changing a field type.
- Changing a field's meaning.

Adding an optional field or sidecar does not require a new version.

The current pre-release checkout supports only recordings with the complete required header. Its schema version remains 1 because earlier artifacts are recreated instead of read.

A reader built for version N accepts exactly version N and reports a clear error for another version. At the first real bump, retain old schemas under versioned directories.

The version appears in the header and every state. The header governs the stream, while the per-state copy keeps an isolated frame self-describing. Readers enforce equality.

## The sidecar rule

A sidecar is an auxiliary file declared by `name` and recording-relative `path`. A reader that does not recognize the name skips it and continues loading the recording.

Sidecars use the recording header's schema version. Adding a new sidecar kind is additive, not a second recording format.
