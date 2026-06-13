# Recordings

A recording is state only: a JSONL file whose first line is the header and whose following lines are one per-step state each (see the [recording spec](../specs/recording.md)). This is the same line-delimited JSON the harness streams over its transport during a live session, so the wire form and the stored form are a single format. Human input, pause and resume, and chat commands travel a separate command envelope and are not recording lines.

## The store interface

The harness exposes a small save and load interface, `RecordingStore`, with three members:

- `create(recording_id, header)` returns a writer context manager. Its `write_step(state)` validates the state, appends exactly one JSONL line, and flushes on every write, so a crashed session leaves a readable prefix rather than a corrupt file.
- `open(recording_id)` returns a recording holding the parsed, validated header and a lazy iterator of validated states.
- `list_ids()` enumerates stored recordings.

Reading enforces that every line's `schema_version` matches the header's, and a blank or truncated trailing line ends the readable prefix instead of failing the read.

## The folder store and the S3 seam

`FolderRecordingStore(root)` lays out one directory per recording, `<root>/<id>/recording.jsonl`, with any sidecars at their header-declared relative paths inside that directory. The per-recording directory is the seam for object storage: it maps one to one onto an object-key prefix, and the protocol names only ids and streams, never filesystem types, so an `S3RecordingStore` can be added behind the same interface later as a purely additive change. No other backends are planned.

There is deliberately no sidecar writing API yet. Stage 1 readers only tolerate declared sidecars; the first writer arrives with the Stage 7 telemetry sidecar. The rule for unknown sidecars is documented under [the state schema](state-schema.md#the-sidecar-rule).
