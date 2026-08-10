# Recordings

A recording is a JSONL file:

```text
line 1: recording header
line 2+: one StepState per line
```

The [harness](../../specs/overview.md) streams and stores the same serialized state lines. Input, pause, resume, stop, and chat commands use event envelopes and are not part of the recording. See the [recording specification](../../specs/recording.md) and [state schema](state-schema.md).

The header contains a `players` map keyed by player id, using the same keys as a step state's `agents`. Each entry is one of three closed variants: human, submitted agent (with `submission_id`), or builtin agent (with `builtin_name`). Its optional `overlay_static` map holds immutable renderer data captured once after reset. Per-step `overlay` data holds the changing part of the scene. See [the state schema](state-schema.md) for the full definitions.

The harness copies this map from the session configuration; the backend assigns each player to its session owner, submission, or builtin agent (see [orchestrator lifecycle](../runtime/execution.md#orchestrator-lifecycle)). It writes every header and state line once, then sends those same bytes to the live relay and recording store.

The required `seats` map groups those player ids under canonical `seat_N` ids. Its nonempty arrays form an exact partition of `players`, so every player belongs to exactly one seat. The `seat_plan` field, also required, records the canonical plan key that produced the partition. Readers use these fields directly instead of resolving current environment metadata. Only headers carrying all three fields are readable, a pre-release policy the [version rule](state-schema.md#the-version-rule) explains.

## External LLM telemetry

LLM telemetry is stored separately, not as a recording [sidecar](state-schema.md#the-sidecar-rule), so it does not change the JSONL header or step schema. For an LLM-enabled recording, the backend stores durable `llm_scope_id` and `llm_session_id` metadata identifying the execution scope: one live session, or one whole workflow run shared by all of that run's matches. The backend uses these identifiers to read successful calls from that scope's single SQLite file.

A live session uses its session ID for both identifiers. Workflow matches share their run ID as `llm_scope_id` and keep the individual match ID as `llm_session_id`. This association lets a retained replay find its external telemetry after the backend prunes the session or workflow that produced it.

An unassociated recording has no LLM calls. An associated recording whose telemetry file is missing or unreadable reports unavailable telemetry rather than an empty result. Retention preserves a referenced scope while any retained recording needs it, and the backend can reclaim the external telemetry afterward.

## The store interface

The harness exposes `RecordingStore`, a small interface with three members:

- `create(recording_id, header)` returns a writer context manager. Its `write_step(state)` validates the state, appends exactly one JSONL line, and flushes on every write, so a crashed session leaves a readable prefix rather than a corrupt file.
- `open(recording_id)` returns a recording holding the parsed, validated header and a lazy iterator of validated states.
- `list_ids()` enumerates stored recordings.

Readers require every state's `schema_version` to match the header. Blank lines are skipped, and a final line that fails to parse as JSON (a truncated write) ends the readable prefix instead of invalidating earlier complete lines.

## The folder store and the S3 seam

`FolderRecordingStore(root)` uses:

```text
<root>/<recording-id>/
  recording.jsonl
  <declared sidecars>
```

Each directory maps naturally to one object-storage key prefix. The interface uses IDs and streams instead of filesystem paths, allowing a future S3-compatible implementation.

There is no general sidecar writing API yet. Readers tolerate declared unknown sidecars according to [the sidecar rule](state-schema.md#the-sidecar-rule).
