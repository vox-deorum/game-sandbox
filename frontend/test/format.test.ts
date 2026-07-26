import { describe, expect, it } from 'vitest'

import { formatDate, formatSeat, formatPlayer } from '../src/lib/format.js'
import { formatScoreMap } from '../src/replay/summary.js'

describe('formatDate', () => {
  it('accepts an ISO string and a Date, formatting both the same, and passes null/undefined through', () => {
    const iso = '2026-06-01T12:00:00.000Z'
    // A Date (e.g. Better Auth's already-revived createdAt) formats identically to its ISO string, so
    // callers need not round-trip a Date back through String().
    expect(formatDate(new Date(iso))).toBe(formatDate(iso))
    expect(formatDate(iso)).not.toBeNull()
    expect(formatDate(null)).toBeNull()
    expect(formatDate(undefined)).toBeNull()
  })
})

describe('formatPlayer', () => {
  it('uses compact player ids and keeps a readable fallback for other slot names', () => {
    expect(formatPlayer('player_0')).toBe('P0')
    expect(formatPlayer('player_12')).toBe('P12')
    expect(formatPlayer('observer_slot')).toBe('Observer Slot')
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
