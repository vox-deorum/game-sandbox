import { describe, expect, it } from 'vitest'

import { canParticipate, isAdmin } from '../src/me.js'
import { anonymousMe, signedInMe } from './helpers/me.js'

// The two capability predicates are pure functions over the resolved /api/me answer: participation
// (start/submit/rate) opens at status `normal`, the operator console only at `admin`. Both must read a
// missing user (anonymous, or no provider) as no capability rather than throwing.
describe('canParticipate', () => {
  it('is true for admin and normal, false otherwise', () => {
    expect(canParticipate(signedInMe('u', 'admin'))).toBe(true)
    expect(canParticipate(signedInMe('u', 'normal'))).toBe(true)
    expect(canParticipate(signedInMe('u', 'pending'))).toBe(false)
    expect(canParticipate(anonymousMe)).toBe(false)
    expect(canParticipate(null)).toBe(false)
  })
})

describe('isAdmin', () => {
  it('is true only for admin', () => {
    expect(isAdmin(signedInMe('u', 'admin'))).toBe(true)
    expect(isAdmin(signedInMe('u', 'normal'))).toBe(false)
    expect(isAdmin(signedInMe('u', 'pending'))).toBe(false)
    expect(isAdmin(anonymousMe)).toBe(false)
    expect(isAdmin(null)).toBe(false)
  })
})
