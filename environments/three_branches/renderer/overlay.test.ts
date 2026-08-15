import { messageKey } from '@game-sandbox/schema/message'
import { describe, expect, it } from 'vitest'

import { expectedCharacterIds, readDynamic, readSpeech, readStatic } from './overlay.js'
import { clonedHeader, fixtureRecording, openingState } from './test-helpers.js'

describe('Three Branches recording overlay', () => {
  it('reads config-shaped static data and preserves the canonical roster from the header', () => {
    const { header } = fixtureRecording()
    const village = readStatic(header)
    expect(village.ground).toHaveLength(village.size.cellsY)
    expect(village.ground.every((row) => row.length === village.size.cellsX)).toBe(true)
    expect(village.spawn.x).toBeGreaterThanOrEqual(0)
    expect(expectedCharacterIds(header)).toEqual(Object.keys(header.players))
  })

  it('accepts a live opening before dynamic overlay data exists', () => {
    const { header } = fixtureRecording()
    expect(readDynamic(openingState(), expectedCharacterIds(header), readStatic(header))).toBeNull()
  })

  it('uses the shared message identity when it names delivered speech', () => {
    const { header, states } = fixtureRecording()
    const state = structuredClone(states[0])
    if (state === undefined) throw new Error('Fixture recording has no state.')
    const message = { from: 'player_0', to: 'player_1', text: 'meet at the well' }
    state.messages = [message]

    expect(readSpeech(state, expectedCharacterIds(header))).toEqual([
      {
        key: messageKey({ tick: state.tick, ...message }),
        speaker: 'player_0',
        addressee: 'player_1',
        text: message.text,
      },
    ])
  })

  it('rejects inconsistent ground and a missing player roster', () => {
    const badGround = clonedHeader()
    const source = badGround.overlay_static as Record<string, unknown>
    source.ground = ['?']
    expect(() => readStatic(badGround)).toThrow('invalid width or ground code')

    const missingRoster = clonedHeader()
    delete missingRoster.players.player_0
    expect(() => expectedCharacterIds(missingRoster)).toThrow('missing player_0')
  })

  it('rejects noncanonical, noncontiguous, and legacy roster ids', () => {
    const leadingZero = clonedHeader()
    delete leadingZero.players.player_1
    leadingZero.players.player_01 = { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' }
    expect(() => expectedCharacterIds(leadingZero)).toThrow('Invalid Three Branches player id player_01')

    const legacy = clonedHeader()
    delete legacy.players.player_1
    legacy.players.npc_0 = { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' }
    expect(() => expectedCharacterIds(legacy)).toThrow('Invalid Three Branches player id npc_0')

    const gap = clonedHeader()
    delete gap.players.player_1
    expect(() => expectedCharacterIds(gap)).toThrow('contiguous')
  })

  it('keeps only speech whose endpoints are exact roster members', () => {
    const { header, states } = fixtureRecording()
    const state = structuredClone(states[0])
    if (state === undefined) throw new Error('Fixture recording has no state.')
    state.messages = [
      { from: 'player_0', to: null, text: 'broadcast' },
      { from: 'player_0', to: 'player_1', text: 'direct' },
      { from: 'player_01', to: null, text: 'leading zero' },
      { from: 'visitor', to: 'player_1', text: 'legacy' },
      { from: 'player_0', to: 'npc_0', text: 'legacy target' },
    ]
    expect(readSpeech(state, expectedCharacterIds(header))).toMatchObject([
      { speaker: 'player_0', addressee: null, text: 'broadcast' },
      { speaker: 'player_0', addressee: 'player_1', text: 'direct' },
    ])
  })
  it('rejects character count and order that disagree with the header', () => {
    const { header, states } = fixtureRecording()
    const village = readStatic(header)
    const expected = expectedCharacterIds(header)
    const state = structuredClone(states[0])
    if (state?.overlay === undefined) throw new Error('Fixture state has no overlay.')
    const characters = state.overlay.characters as unknown[]
    characters.reverse()
    expect(() => readDynamic(state, expected, village)).toThrow('recording roster')
    characters.pop()
    expect(() => readDynamic(state, expected, village)).toThrow('recording roster')
  })
})
