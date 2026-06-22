# The State Schema

The per-step state is the contract between Python, TypeScript, live transport, and replay:

```text
JSON Schema → Python validation
            → generated TypeScript types
            → live state lines
            → recording state lines
```

The source uses JSON Schema draft 2020-12 under `schema/`. This page defines versioning and sidecar compatibility. See [Execution](execution.md) and [Recordings](recordings.md).

## The two files

- `schema/step-state.schema.json` is the per-step state object: `schema_version`, `tick`, per-agent observations, actions, rewards and cumulative scores, an open `overlay` for environment-specific fields, optional `messages`, and `timing`. Field names are snake_case throughout, which is JSON-conventional and Python-native, and the generated TypeScript types mirror it.
- `schema/recording-header.schema.json` is the recording header: `schema_version`, `environment`, an optional `seed` and `created_at`, the `sidecars` array, and an optional `players` map (slot id to `{kind, label, user?, submission_id?}`) that attributes each slot to a human or an agent. The header object stays open (`additionalProperties: true`) so a new optional field like `players` is purely additive, with no `schema_version` bump, and the generated TypeScript field comes for free from `scripts/generate.py`; each `players` entry is itself a closed region (`additionalProperties: false`) so a malformed attribution is loud.

Closed regions use `additionalProperties: false` so accidental drift fails loudly. `overlay` is the designated open extension region for environment-specific display data.

`messages` and `overlay` exist in the initial schema even before every capability uses them. Reserving those extension points avoids a breaking schema revision when messaging or another renderer payload becomes active.

## The version rule

`schema_version` is an integer that changes only for a breaking change:

- Removing or renaming a field.
- Changing a field type.
- Changing a field's meaning.

Adding an optional field or sidecar does not require a new version.

A reader built for version N accepts exactly version N and reports a clear error for another version. At the first real bump, retain old schemas under versioned directories.

The version appears in the header and every state. The header governs the stream, while the per-state copy keeps an isolated frame self-describing. Readers enforce equality.

## The sidecar rule

A sidecar is an auxiliary file declared by `name` and recording-relative `path`. A reader that does not recognize the name skips it and continues loading the recording.

Sidecars use the recording header's schema version. Adding a new sidecar kind is additive, not a second recording format.
