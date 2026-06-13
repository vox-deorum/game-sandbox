# The State Schema

The per-step state object is the contract across the container boundary (see the [execution spec](../specs/execution.md)). It is defined once as a versioned JSON Schema under `schema/`, draft 2020-12, and it is the single source of truth for both the wire format and the stored format. The TypeScript backend and renderer derive their types from it, and the Python harness validates every payload it emits against it. This page is the normative home of the version rule and the sidecar rule; the schema files only carry field descriptions, and `schema/README.md` points here.

## The two files

- `schema/step-state.schema.json` is the per-step state object: `schema_version`, `tick`, per-agent observations, actions, rewards and cumulative scores, an open `overlay` for environment-specific fields, optional `messages`, and `timing`. Field names are snake_case throughout, which is JSON-conventional and Python-native, and the generated TypeScript types mirror it.
- `schema/recording-header.schema.json` is the recording header: `schema_version`, `environment`, an optional `seed` and `created_at`, and the `sidecars` array.

`messages` and `overlay` exist from day one even though messaging arrives in Stage 9, so the schema needs no breaking revision when chat lights up. Every closed region sets `additionalProperties: false` so accidental drift is loud; `overlay` is the one open object, the designated extension region for environment payloads.

## The version rule

`schema_version` is a single integer, starting at 1. It bumps only on a breaking change: removing, renaming, retyping, or changing the meaning of a defined field. Additive changes (a new optional field, a new sidecar name) do not bump it, and readers ignore unknown content in the regions the schema leaves open. A single integer is enough because producers and consumers are generated from the same repository and nothing is published to a registry, so semver would buy nothing while an integer compares trivially in both languages and stays compact in a JSONL header.

The compatibility rule in one sentence: a reader built for version N accepts exactly version N and rejects anything else with a clear error. Old recordings stay replayable because when a bump ever happens the old schema file is retained; the escalation path is to move to `schema/v1/`, `schema/v2/` directories at the first real bump, and stay flat until then.

`schema_version` appears in both the recording header and every per-step state. The header is authoritative for a recording or a stream; the per-step copy makes a single state object self-describing when it travels alone, such as a relayed live frame or a fixture file. Loaders enforce equality between the header and every line. The redundancy is deliberate.

## The sidecar rule

A sidecar is an auxiliary file stored alongside a recording, declared in the header's `sidecars` array by `name` and `path`. The `name` identifies the sidecar's kind against a registry of known names, which is empty today; the `path` is relative to the recording's own directory. A reader that does not recognize a sidecar name must skip that entry and load the recording normally, and unknown keys inside a sidecar entry are likewise ignored.

Sidecar payload schemas, when they arrive (the Stage 7 LLM telemetry is the first), are covered by the same `schema_version` as the recording header, so adding one is an additive contract change, never a second storage format.
