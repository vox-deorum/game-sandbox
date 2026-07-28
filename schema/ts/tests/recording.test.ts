/**
 * Golden fixtures make the recording exit criteria executable: typed state fields,
 * partnership and solo seat maps, version rejection, and unknown-sidecar tolerance.
 * Python writes every supported fixture through the real recording store.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { parseHeader, parseStepState, readRecording, SchemaValidationError } from '../src/index.js'

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

    // Per-player attribution round-trips through the real store into the generated `players` field.
    expect(header.players.player_0?.kind).toBe('agent')
    expect(header.players.player_0?.label).toBe('Naive agent')
    expect(header.seats).toEqual({ seat_0: ['player_0'] })
    expect(header.seat_plan).toBe('solo')
  })

  it('rejects a recording whose schema_version was bumped', () => {
    expect(() => readRecording(fixture('bumped-version'))).toThrow(SchemaValidationError)
  })

  it('loads a recording that declares an unknown sidecar', () => {
    const { header, states } = readRecording(fixture('unknown-sidecar'))
    expect(header.sidecars?.[0]?.name).toBe('future-telemetry')
    expect(states).toHaveLength(1)
  })

  it('parses partnership and solo Spades recordings with their exact seat maps', () => {
    const partnership = readRecording(fixture('chatty'))
    const solo = readRecording(fixture('chatty-solo'))
    const [first] = partnership.states

    expect(partnership.header.parameters).toEqual({ seat_plan: 'partnership' })
    expect(partnership.header.seat_plan).toBe('partnership')
    expect(partnership.header.seats).toEqual({
      seat_0: ['player_0', 'player_2'],
      seat_1: ['player_1', 'player_3'],
    })
    expect(solo.header.parameters).toEqual({ seat_plan: 'solo' })
    expect(solo.header.seat_plan).toBe('solo')
    expect(solo.header.seats).toEqual({
      seat_0: ['player_0'],
      seat_1: ['player_1'],
      seat_2: ['player_2'],
      seat_3: ['player_3'],
    })

    // The regenerated types carry chat_ms alongside decision_ms, so no cast below.
    const timing = first?.agents.player_0?.timing
    expect(timing?.decision_ms).toBe(0.5)
    expect(timing?.chat_ms).toBe(0.25)
    expect(first?.chat_options).toEqual({
      sender: 'player_0',
      target_recipients: ['player_2', 'player_1', 'player_3'],
      default_recipient: 'player_2',
    })

    // The messages array: one targeted, one broadcast (to === null), typed straight through.
    expect(first?.messages).toHaveLength(2)
    expect(first?.messages?.[0]).toEqual({
      from: 'player_0',
      to: 'player_2',
      text: 'strong:hearts',
    })
    expect(first?.messages?.[1]?.to).toBeNull()
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

describe('parseHeader', () => {
  it('rejects an empty submitted-agent identity', () => {
    expect(() =>
      parseHeader({
        schema_version: 1,
        environment: 'flappy',
        parameters: {},
        players: {
          player_0: { kind: 'agent', label: 'Submitted agent', submission_id: '' },
        },
        seats: { seat_0: ['player_0'] },
        seat_plan: 'solo',
      }),
    ).toThrow(SchemaValidationError)
  })

  it('rejects player attribution with an empty label', () => {
    expect(() =>
      parseHeader({
        schema_version: 1,
        environment: 'flappy',
        parameters: {},
        players: { player_0: { kind: 'agent', label: '' } },
        seats: { seat_0: ['player_0'] },
        seat_plan: 'solo',
      }),
    ).toThrow(SchemaValidationError)
  })

  it('requires the seat map and plan, then rejects a seat map that is not an exact player partition', () => {
    const header = {
      schema_version: 1,
      environment: 'flappy',
      parameters: {},
      players: { player_0: { kind: 'agent', label: 'Naive agent' } },
      seats: { seat_0: ['player_1'] },
      seat_plan: 'solo',
    }
    expect(() => parseHeader({ ...header, seats: undefined })).toThrow(SchemaValidationError)
    expect(() => parseHeader({ ...header, seat_plan: undefined })).toThrow(SchemaValidationError)
    expect(() => parseHeader(header)).toThrow(SchemaValidationError)
  })
})
