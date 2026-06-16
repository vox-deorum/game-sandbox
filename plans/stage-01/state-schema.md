# Stage 1: Per-Step State Schema and Versioning

Part of [Stage 1](../stage-01-contracts.md). This file designs the two schema files, the version rule, and the sidecar rule. The schema is the single source of truth for the wire format and the stored format alike, per [execution.md](../../docs/specs/execution.md) and [recording.md](../../docs/specs/recording.md); the fields come from [interaction.md](../../docs/specs/interaction.md).

## Files and conventions

Two JSON Schema files, both draft 2020-12: `schema/step-state.schema.json` for the per-step state object and `schema/recording-header.schema.json` for the recording header. Their `$id` values live under `https://vox-deorum.github.io/game-sandbox/schema/`. Field names are snake_case throughout. That is JSON-conventional and Python-native, and the generated TypeScript types simply mirror it.

## Version semantics

`schema_version` is a single integer, starting at 1. It bumps only on breaking changes: removing, renaming, retyping, or changing the meaning of a defined field. Additive changes (a new optional field, a new sidecar name) do not bump it, because readers ignore unknown content in the regions the schema explicitly leaves open. Semver buys nothing here: producers and consumers are generated from the same repository and nothing is published to a registry, while a single integer compares trivially in both languages and stays compact in a JSONL header.

The compatibility rule in one sentence: a reader built for version N accepts exactly version N and rejects anything else with a clear error. Old recordings stay replayable because, when a bump ever happens, the old schema file is retained. The escalation path is to move to `schema/v1/`, `schema/v2/` directories at the first real bump, and stay flat until then.

`schema_version` appears in both the recording header and every per-step state. The header is authoritative for a recording or a stream. The per-step copy makes a single state object self-describing when it travels alone, such as a relayed frame in Stage 3 or a fixture file. Loaders enforce equality between the header and every line. The redundancy is deliberate and documented.

## Per-step state

The schema to author, near verbatim:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://vox-deorum.github.io/game-sandbox/schema/step-state.schema.json",
  "title": "StepState",
  "type": "object",
  "required": ["schema_version", "tick", "agents", "timing"],
  "additionalProperties": false,
  "properties": {
    "schema_version": { "const": 1 },
    "tick": { "type": "integer", "minimum": 0 },
    "agents": {
      "type": "object",
      "additionalProperties": { "$ref": "#/$defs/agent_step" }
    },
    "overlay": { "type": "object" },
    "messages": { "type": "array", "items": { "$ref": "#/$defs/message" } },
    "timing": { "$ref": "#/$defs/step_timing" }
  },
  "$defs": {
    "agent_step": {
      "type": "object",
      "required": ["reward", "score"],
      "additionalProperties": false,
      "properties": {
        "observation": {},
        "action": {},
        "reward": { "type": "number" },
        "score": { "type": "number" },
        "timing": {
          "type": "object",
          "additionalProperties": false,
          "properties": { "decision_ms": { "type": "number", "minimum": 0 } }
        }
      }
    },
    "message": {
      "type": "object",
      "required": ["from", "to", "text"],
      "additionalProperties": false,
      "properties": {
        "from": { "type": "string" },
        "to": { "type": ["string", "null"] },
        "text": { "type": "string" }
      }
    },
    "step_timing": {
      "type": "object",
      "required": ["started_at", "duration_ms"],
      "additionalProperties": false,
      "properties": {
        "started_at": { "type": "integer", "description": "epoch milliseconds UTC" },
        "duration_ms": { "type": "number", "minimum": 0 }
      }
    }
  }
}
```

Design notes:

- `agents` is an object keyed by slot id (a string matching the PettingZoo agent id), because renderer lookup is direct and slot counts vary per environment. The exact id conventions are settled in Stage 2 when real PettingZoo ids exist.
- `observation` and `action` are deliberately untyped, since their shape is environment-specific and the renderer is their only consumer.
- `overlay` is the one fully open object, the designated extension region for environment payloads like pipe positions.
- `messages` is optional and absent when empty, which keeps lines small. The shape exists from day one so Stage 8 lights it up without a schema revision, and `to: null` means broadcast.
- The per-agent `decision_ms` stays pure act time. Leaderboard compute can combine it with `learn_ms`, `chat_ms`, and later hook timing fields without a version bump.
- `additionalProperties: false` everywhere except `overlay` is intentional. Closed regions make accidental drift loud; the open region makes environment variation cheap.

## Recording header

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://vox-deorum.github.io/game-sandbox/schema/recording-header.schema.json",
  "title": "RecordingHeader",
  "type": "object",
  "required": ["schema_version", "environment"],
  "additionalProperties": true,
  "properties": {
    "schema_version": { "const": 1 },
    "environment": { "type": "string" },
    "created_at": { "type": "string", "format": "date-time" },
    "seed": { "type": "integer" },
    "sidecars": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name", "path"],
        "properties": {
          "name": { "type": "string" },
          "path": { "type": "string" }
        }
      }
    }
  }
}
```

The header is line 1 of every recording and the first frame of the Stage 3 live stream. Position distinguishes it from state lines, so there is no `type` discriminator field; a discriminator can be added additively later if Stage 3 wants one. `seed` is optional now and filled in by Stage 2. The header is an open region (`additionalProperties: true`), so it can grow additively.

## The sidecar rule

This wording is normative and is mirrored on the docs site. A sidecar is an auxiliary file stored alongside a recording, declared in the header's `sidecars` array by `name` and `path`. The `name` identifies the sidecar's kind against a registry of known names, which is empty in Stage 1. The `path` is relative to the recording's own directory. A reader that does not recognize a sidecar name must skip that entry and load the recording normally. Unknown keys inside a sidecar entry are likewise ignored. Sidecar payload schemas, when they arrive (the Stage 9 LLM telemetry is the first), are covered by the same `schema_version` as the recording header, so adding one is an additive contract change, never a second storage format.
