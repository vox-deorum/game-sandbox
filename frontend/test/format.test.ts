import { describe, expect, it } from 'vitest'

import { formatDate, formatSlot } from '../src/lib/format.js'
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

describe('formatSlot', () => {
  it('uses compact player ids and keeps a readable fallback for other slot names', () => {
    expect(formatSlot('player_0')).toBe('P0')
    expect(formatSlot('player_12')).toBe('P12')
    expect(formatSlot('observer_slot')).toBe('Observer Slot')
  })

  it('uses compact player ids in multiplayer score summaries', () => {
    expect(formatScoreMap({ player_0: 8, player_1: 3 })).toBe('P0: 8, P1: 3')
  })
})
