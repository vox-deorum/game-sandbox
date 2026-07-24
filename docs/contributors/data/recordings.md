# Recordings

A recording is a JSONL file:

```text
line 1: recording header
line 2+: one StepState per line
```

The harness streams and stores the same serialized state lines. Input, pause, resume, stop, and chat commands use event envelopes and are not part of the recording. See the [recording specification](../../specs/recording.md) and [state schema](state-schema.md).

The header may include a `players` map keyed by slot id, using the same keys as a step state's `agents`. Each entry has the shape `{kind: "human" | "agent", label, user?, submission_id?}`.

The harness copies this map from the session configuration. The backend assigns:

- Human slots to the session owner.
- Submitted slots to the submission owner and id.
- Other built-in slots to the "Naive agent".

The field is optional, so older recordings remain readable.

## External LLM telemetry

LLM telemetry is stored separately, not as a recording sidecar, so it does not change the JSONL header or step schema. For an LLM-enabled recording, the backend stores durable `llm_scope_id` and `llm_session_id` metadata. It uses these identifiers to read successful calls from the execution scope's SQLite file.

A live session uses its session ID for both identifiers. Workflow matches share their run ID as `llm_scope_id` and keep the individual match ID as `llm_session_id`. This association lets a retained replay find its external telemetry after the backend prunes the session or workflow that produced it.

An unassociated recording has no LLM calls. An associated recording whose telemetry file is missing or unreadable reports unavailable telemetry rather than an empty result. Retention preserves a referenced scope while any retained recording needs it. The backend can reclaim the external telemetry afterward.

## The store interface

The harness exposes `RecordingStore`, a small interface with three members:

- `create(recording_id, header)` returns a writer context manager. Its `write_step(state)` validates the state, appends exactly one JSONL line, and flushes on every write, so a crashed session leaves a readable prefix rather than a corrupt file.
- `open(recording_id)` returns a recording holding the parsed, validated header and a lazy iterator of validated states.
- `list_ids()` enumerates stored recordings.

Readers require every state's `schema_version` to match the header. A blank or truncated final line ends the readable prefix instead of invalidating earlier complete lines.

## The folder store and the S3 seam

`FolderRecordingStore(root)` uses:

```text
<root>/<recording-id>/
  recording.jsonl
  <declared sidecars>
```

Each directory maps naturally to one object-storage key prefix. The interface uses IDs and streams instead of filesystem paths, allowing a future S3-compatible implementation.

There is no general sidecar writing API yet. Readers tolerate declared unknown sidecars according to [the sidecar rule](state-schema.md#the-sidecar-rule).
