/**
 * The three golden fixtures are the stage's exit criteria made executable: a two-step
 * recording that parses into the generated types with no casts, a bumped-version
 * recording that must be rejected, and an unknown-sidecar recording that must load
 * cleanly. The fixtures are written by Python through the real recording store.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { SchemaValidationError, parseStepState, readRecording } from '../src/index.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures')

function fixture(id: string): string {
  return readFileSync(join(FIXTURES, id, 'recording.jsonl'), 'utf-8')
}

describe('readRecording', () => {
  it('parses a two-step recording into generated types with no casts', () => {
    const { header, states } = readRecording(fixture('two-step'))

    expect(header.environment).toBe('flappy')
    expect(header.schema_version).toBe(1)
    expect(states).toHaveLength(2)

    // No casts below: `states` is typed StepState[] straight out of readRecording.
    const [first, second] = states
    expect(first?.tick).toBe(0)
    const agent = first?.agents.player_0
    expect(agent?.reward).toBe(0)
    expect(agent?.score).toBe(0)
    expect(second?.tick).toBe(1)
  })

  it('rejects a recording whose schema_version was bumped', () => {
    expect(() => readRecording(fixture('bumped-version'))).toThrow(SchemaValidationError)
  })

  it('loads a recording that declares an unknown sidecar', () => {
    const { header, states } = readRecording(fixture('unknown-sidecar'))
    expect(header.sidecars?.[0]?.name).toBe('future-telemetry')
    expect(states).toHaveLength(1)
  })
})

describe('parseStepState', () => {
  it('rejects an object with an unknown field in a closed region', () => {
    expect(() =>
      parseStepState({ schema_version: 1, tick: 0, agents: {}, timing: {}, oops: 1 }),
    ).toThrow(SchemaValidationError)
  })

  it('tolerates a truncated trailing line as the end of the prefix', () => {
    const text = `${fixture('two-step').trimEnd()}\n{"schema_version":1,"tick":2,"age`
    const { states } = readRecording(text)
    expect(states).toHaveLength(2)
  })
})
