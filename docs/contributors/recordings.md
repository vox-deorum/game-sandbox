# Recordings

A recording is a JSONL file:

```text
line 1: recording header
line 2+: one StepState per line
```

The harness streams and stores the same serialized state lines. Input, pause, resume, stop, and chat commands are event envelopes, not recording lines. See the [recording specification](../specs/recording.md) and [state schema](state-schema.md).

The header may include a `players` map keyed by slot id, using the same keys as a step state's `agents`. Each entry has the shape `{kind: "human" | "agent", label, user?, submission_id?}`.

The harness copies the map from session configuration. The backend assigns:

- Human slots to the session owner.
- Submitted slots to the submission owner and id.
- Other built-in slots to the "Naive agent".

The field is optional, so older recordings remain readable.

## External LLM telemetry

LLM telemetry is not a recording sidecar and does not change the JSONL header or step schema. The backend records durable `llm_scope_id` and `llm_session_id` metadata for an LLM-enabled recording, then uses those identifiers to read successful-call rows from the execution-scope SQLite file.

A live session uses its session ID for both identifiers. Workflow matches share their run ID as `llm_scope_id` and keep the individual match ID as `llm_session_id`. This association allows a retained replay to resolve external telemetry after its producing session or workflow data is pruned.

An unassociated recording has no LLM calls. An associated recording whose telemetry file is missing or unreadable reports unavailable telemetry rather than an empty result. Retention preserves a referenced scope until no retained recording needs it, then allows the backend to reclaim the external telemetry.

## The store interface

The harness exposes a small save and load interface, `RecordingStore`, with three members:

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

One directory maps naturally to one object-storage key prefix. The interface names IDs and streams rather than filesystem paths, so an S3-compatible store can be added later.

There is no general sidecar writing API yet. Readers tolerate declared unknown sidecars according to [the sidecar rule](state-schema.md#the-sidecar-rule).
