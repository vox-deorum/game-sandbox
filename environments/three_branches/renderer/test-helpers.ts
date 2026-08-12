import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { RecordingHeader, StepState } from '@game-sandbox/schema'

let cached: { header: RecordingHeader; states: StepState[] } | null = null

/** Read the committed recording once for renderer tests that need production-shaped data. */
export function fixtureRecording(): { header: RecordingHeader; states: StepState[] } {
  if (cached !== null) return cached
  const path = resolve(process.cwd(), 'test/fixtures/three-branches-recording.jsonl')
  const [headerLine, ...stateLines] = readFileSync(path, 'utf8').trim().split('\n')
  if (headerLine === undefined) throw new Error('Three Branches fixture is empty.')
  cached = {
    header: JSON.parse(headerLine) as RecordingHeader,
    states: stateLines.map((line) => JSON.parse(line) as StepState),
  }
  return cached
}

/** Clone a fixture header so rejection tests cannot mutate the shared cached value. */
export function clonedHeader(): RecordingHeader {
  return structuredClone(fixtureRecording().header)
}

/** Build the ordinary opening state that can precede a simultaneous live transition. */
export function openingState(): StepState {
  return {
    schema_version: 1,
    tick: 0,
    agents: {},
    timing: { started_at: 0, duration_ms: 0 },
  }
}
