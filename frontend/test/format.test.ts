import type { StepState } from '@game-sandbox/schema'
import { describe, expect, it } from 'vitest'

import {
  formatDate,
  formatDuration,
  formatLogTime,
  formatPlayer,
  formatSeat,
} from '../src/lib/format.js'
import { decisionEntries, latestPlayerScores, toPlayerScores } from '../src/lib/state.js'
import { formatScoreMap } from '../src/replay/summary.js'
import { useFixedDateTimeFormat } from './helpers/intl.js'

describe('formatDate', () => {
  useFixedDateTimeFormat()

  it('formats a UTC date in the selected locale and passes null/undefined through', () => {
    const iso = '2026-06-01T12:00:00.000Z'
    expect(formatDate(iso)).toBe('Jun 1, 2026, 12:00 PM')
    expect(formatDate(new Date(iso))).toBe('Jun 1, 2026, 12:00 PM')
    expect(formatDate(null)).toBeNull()
    expect(formatDate(undefined)).toBeNull()
  })

  it('formats log timestamps as a 24-hour clock in the viewer time zone', () => {
    expect(formatLogTime(Date.parse('2026-06-01T09:07:05.000Z'))).toBe('09:07:05')
  })
})

describe('formatDuration', () => {
  it('uses compact human units for exact limits', () => {
    expect(formatDuration(500)).toBe('0.5 s')
    expect(formatDuration(1000)).toBe('1 s')
    expect(formatDuration(120_000)).toBe('120 s')
    expect(formatDuration(1500)).toBe('1.5 s')
  })
})

describe('formatPlayer', () => {
  it('uses compact player ids and keeps a readable fallback for other names', () => {
    expect(formatPlayer('player_0')).toBe('P0')
    expect(formatPlayer('player_12')).toBe('P12')
    expect(formatPlayer('observer_player')).toBe('Observer Player')
  })

  it('uses compact player ids in multiplayer score summaries', () => {
    expect(formatScoreMap({ player_0: 8, player_1: 3 })).toBe('P0: 8, P1: 3')
  })
})

describe('formatSeat', () => {
  it('uses compact seat ids and keeps a readable fallback for other seat names', () => {
    expect(formatSeat('seat_0')).toBe('S0')
    expect(formatSeat('seat_12')).toBe('S12')
    expect(formatSeat('reserved_seat')).toBe('Reserved Seat')
  })

  // Seats and players are numbered independently and a seat may cover several players, so seat 0 and
  // player 0 are not interchangeable. The letters keep them apart wherever both appear in one view.
  it('does not share a short form with a player id', () => {
    expect(formatSeat('seat_0')).not.toBe(formatPlayer('player_0'))
    expect(formatSeat('player_0')).not.toBe('P0')
  })
})

describe('state reductions', () => {
  it('preserves canonical order for action-bearing entries and omits reward-only deltas', () => {
    const state: StepState = {
      schema_version: 1,
      tick: 8,
      agents: {
        player_2: { reward: 1, score: 4, action: 'left' },
        player_0: { reward: 2, score: 7 },
        player_1: { reward: 3, score: 9, action: 'right' },
      },
      timing: { started_at: 0, duration_ms: 1 },
    }

    expect(decisionEntries(state)).toEqual([
      { tick: 8, player: 'player_2', action: 'left' },
      { tick: 8, player: 'player_1', action: 'right' },
    ])
  })

  it('retains each player latest score when later states omit inactive players', () => {
    const states: StepState[] = [
      {
        schema_version: 1,
        tick: 0,
        agents: {
          player_0: { reward: 1, score: 1, action: 0 },
          player_1: { reward: 0, score: 0, action: 1 },
        },
        timing: { started_at: 0, duration_ms: 1 },
      },
      {
        schema_version: 1,
        tick: 1,
        agents: {
          player_0: { reward: 3, score: 4 },
          player_1: { reward: 2, score: 2, action: 1 },
        },
        timing: { started_at: 1, duration_ms: 1 },
      },
      {
        schema_version: 1,
        tick: 2,
        agents: { player_1: { reward: 2, score: 4, action: 1 } },
        timing: { started_at: 2, duration_ms: 1 },
      },
    ]

    states.push({
      schema_version: 1,
      tick: 3,
      agents: {
        player_0: { reward: 0, score: Number.NaN },
        player_1: { reward: 0, score: Number.POSITIVE_INFINITY },
      },
      timing: { started_at: 3, duration_ms: 1 },
    })

    expect(latestPlayerScores(states)).toEqual({ player_0: 4, player_1: 4 })
  })
})

describe('toPlayerScores', () => {
  it('drops non-object inputs and arrays', () => {
    expect(toPlayerScores(null)).toEqual({})
    expect(toPlayerScores('scores')).toEqual({})
    expect(toPlayerScores([1, 2])).toEqual({})
  })

  it('keeps only finite numeric scores', () => {
    expect(
      toPlayerScores({
        player_0: 7,
        player_1: '3',
        player_2: Number.NaN,
        player_3: Number.POSITIVE_INFINITY,
        player_4: Number.NEGATIVE_INFINITY,
      }),
    ).toEqual({ player_0: 7 })
  })
})
