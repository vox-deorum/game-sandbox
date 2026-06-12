/**
 * A dependency-free recording parser for the browser. The schema package's `readRecording` is
 * Ajv-backed and reads schema files with `node:fs`, so it cannot run in the bundle (see
 * frontend-infrastructure.md). This mirrors its behavior — header first, then one state per line,
 * every line's `schema_version` matching the header's, a truncated trailing line ending the readable
 * prefix — using structural casts against the shared types instead of runtime validation: the backend
 * is authoritative and already shaped these lines.
 *
 * The one check that earns its keep here is the version gate: a header version this viewer does not
 * understand surfaces as {@link UnsupportedVersionError}, which is exactly the breakage the header
 * version exists to catch ("this replay needs a newer viewer").
 */
import type { RecordingHeader, StepState } from '@game-sandbox/schema'
import { SCHEMA_VERSION } from '@game-sandbox/schema/version'

/** The recording declares a schema version this viewer does not understand. */
export class UnsupportedVersionError extends Error {}
/** The recording is empty or its header is not valid JSON. */
export class MalformedRecordingError extends Error {}

export interface ParsedRecording {
  header: RecordingHeader
  states: StepState[]
}

/** Parse a recording's JSONL text into its header and the readable prefix of its states. */
export function parseRecording(text: string): ParsedRecording {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const headerLine = lines[0]
  if (headerLine === undefined) {
    throw new MalformedRecordingError('recording is empty')
  }
  let header: RecordingHeader
  try {
    header = JSON.parse(headerLine) as RecordingHeader
  } catch {
    throw new MalformedRecordingError('recording header is not valid JSON')
  }
  if (header.schema_version !== SCHEMA_VERSION) {
    throw new UnsupportedVersionError(
      `this replay was recorded with schema version ${header.schema_version}; this viewer understands version ${SCHEMA_VERSION}`,
    )
  }

  const states: StepState[] = []
  for (const line of lines.slice(1)) {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      // A crashed session can leave a half-written final line; stop at the readable prefix.
      break
    }
    const state = value as StepState
    if (state.schema_version !== header.schema_version) {
      throw new UnsupportedVersionError(
        `a state line declares schema version ${state.schema_version}, not the header's ${header.schema_version}`,
      )
    }
    states.push(state)
  }
  return { header, states }
}
