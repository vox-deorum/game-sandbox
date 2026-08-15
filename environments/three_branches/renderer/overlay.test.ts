import { messageKey } from '@game-sandbox/schema/message'
import { describe, expect, it } from 'vitest'

import { expectedCharacterIds, readDynamic, readSpeech, readStatic } from './overlay.js'
import { clonedHeader, fixtureRecording, openingState } from './test-helpers.js'

describe('Three Branches recording overlay', () => {
  it('reads config-shaped static data and derives the visitor-first roster from the header', () => {
    const { header } = fixtureRecording()
    const village = readStatic(header)
    expect(village.ground).toHaveLength(village.size.cellsY)
    expect(village.ground.every((row) => row.length === village.size.cellsX)).toBe(true)
    expect(village.spawn.x).toBeGreaterThanOrEqual(0)
    expect(expectedCharacterIds(header)).toEqual(
      Object.keys(header.players).map((_, index) => (index === 0 ? 'visitor' : `npc_${index - 1}`)),
    )
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
        speaker: 'visitor',
        addressee: 'npc_0',
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
