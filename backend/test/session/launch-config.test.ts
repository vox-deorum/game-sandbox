import type { ResolvedLayout } from '@game-sandbox/schema/environment'
import { describe, expect, it } from 'vitest'

import { assembleLaunch } from '../../src/session/launch-config.js'

/** A resolved layout from its seats alone; the derived counts follow from them. */
function layoutOf(seats: { seatId: string; players: string[] }[]): ResolvedLayout {
  return {
    planKey: 'test',
    seats: seats.map((seat) => ({ ...seat, restrictedBuiltin: null })),
    seatCount: seats.length,
    playerCount: seats.reduce((total, seat) => total + seat.players.length, 0),
  }
}

const WIDE_LAYOUT = layoutOf([
  { seatId: 'seat_0', players: ['player_0', 'player_2'] },
  { seatId: 'seat_1', players: ['player_1'] },
])
const SINGLETON_LAYOUT = layoutOf([{ seatId: 'seat_0', players: ['player_0'] }])

describe('assembleLaunch', () => {
  it('snapshots a named built-in identity and label', () => {
    const launch = assembleLaunch(
      new Map([['seat_0', { driver: 'builtin', name: 'cautious', label: 'Cautious bidder' }]]),
      SINGLETON_LAYOUT,
    )
    expect(launch).toEqual({
      playerBindings: { player_0: { kind: 'builtin-agent', name: 'cautious' } },
      players: { player_0: { kind: 'agent', builtin_name: 'cautious', label: 'Cautious bidder' } },
    })
  })

  it('expands one submitted seat into distinct player bindings sharing its seat path', () => {
    const launch = assembleLaunch(
      new Map([
        [
          'seat_0',
          { driver: 'submission', submissionId: 'sub-1', userId: 'alice', path: '/agents/seat_0' },
        ],
        ['seat_1', { driver: 'builtin', name: 'naive', label: 'Naive agent' }],
      ]),
      WIDE_LAYOUT,
    )

    expect(launch.playerBindings).toEqual({
      player_0: { kind: 'builtin-agent', path: '/agents/seat_0' },
      player_1: { kind: 'builtin-agent', name: 'naive' },
      player_2: { kind: 'builtin-agent', path: '/agents/seat_0' },
    })
    expect(launch.players.player_2).toMatchObject({ submission_id: 'sub-1', user: 'alice' })
  })

  it('makes only the named human player external and applies its companion to the rest', () => {
    const launch = assembleLaunch(
      new Map([
        [
          'seat_0',
          {
            driver: 'human',
            playerIds: ['player_2'],
            userId: 'person',
            companion: {
              driver: 'submission',
              submissionId: 'sub-1',
              userId: 'alice',
              path: '/agents/seat_0',
            },
          },
        ],
        ['seat_1', { driver: 'builtin', name: 'naive', label: 'Naive agent' }],
      ]),
      WIDE_LAYOUT,
    )

    expect(launch.playerBindings.player_2).toEqual({ kind: 'external' })
    expect(launch.playerBindings.player_0).toEqual({
      kind: 'builtin-agent',
      path: '/agents/seat_0',
    })
    expect(launch.players.player_2).toMatchObject({ kind: 'human', user: 'person' })
  })

  // Whether a seat may be human at all, and whether a companion is required or forbidden for its
  // width, is settled by the orchestrator's seat validation as a 400. Only the two rules expansion
  // itself owns are checked here. A human companion is unrepresentable: `SeatBinding.companion` is
  // typed to the agent drivers, so there is no runtime case left to test.
  it('makes every named human player external without a companion', () => {
    const launch = assembleLaunch(
      new Map([
        ['seat_0', { driver: 'human', playerIds: ['player_0', 'player_2'], userId: 'person' }],
        ['seat_1', { driver: 'builtin', name: 'naive', label: 'Naive agent' }],
      ]),
      WIDE_LAYOUT,
    )

    expect(launch.playerBindings.player_0).toEqual({ kind: 'external' })
    expect(launch.playerBindings.player_2).toEqual({ kind: 'external' })
    expect(launch.players.player_0).toMatchObject({ kind: 'human', user: 'person' })
    expect(launch.players.player_2).toMatchObject({ kind: 'human', user: 'person' })
  })

  it('rejects a human seat naming a player outside it', () => {
    expect(() =>
      assembleLaunch(
        new Map([
          ['seat_0', { driver: 'human', playerIds: ['player_1'], userId: 'person' }],
          ['seat_1', { driver: 'builtin', name: 'naive', label: 'Naive agent' }],
        ]),
        WIDE_LAYOUT,
      ),
    ).toThrow(/outside it/)
  })

  it('rejects a wide human seat without a companion', () => {
    expect(() =>
      assembleLaunch(
        new Map([
          ['seat_0', { driver: 'human', playerIds: ['player_0'], userId: 'person' }],
          ['seat_1', { driver: 'builtin', name: 'naive', label: 'Naive agent' }],
        ]),
        WIDE_LAYOUT,
      ),
    ).toThrow(/needs a companion/)
  })

  it('rejects missing and extra seat assignments', () => {
    expect(() => assembleLaunch(new Map(), WIDE_LAYOUT)).toThrow(/missing seat binding/)
    expect(() =>
      assembleLaunch(
        new Map([
          ['seat_0', { driver: 'builtin', name: 'naive', label: 'Naive agent' }],
          ['seat_1', { driver: 'builtin', name: 'naive', label: 'Naive agent' }],
          ['seat_2', { driver: 'builtin', name: 'naive', label: 'Naive agent' }],
        ]),
        WIDE_LAYOUT,
      ),
    ).toThrow(/unexpected seat binding/)
  })

  it('rejects a layout that emits one player twice', () => {
    expect(() =>
      assembleLaunch(
        new Map([
          ['seat_0', { driver: 'builtin', name: 'naive', label: 'Naive agent' }],
          ['seat_1', { driver: 'builtin', name: 'naive', label: 'Naive agent' }],
        ]),
        layoutOf([
          { seatId: 'seat_0', players: ['player_0'] },
          { seatId: 'seat_1', players: ['player_0'] },
        ]),
      ),
    ).toThrow(/duplicate player binding/)
  })
})
