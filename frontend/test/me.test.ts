import { describe, expect, it } from 'vitest'

import { canParticipate, canPlay, hidesNames, isAdmin } from '../src/me.js'
import { anonymousMe, signedInMe } from './helpers/me.js'

// The capability predicates are pure functions over the resolved /api/me answer: participation
// (submit/rate) opens at status `normal`, the operator console only at `admin`, play also admits a
// `guest`, and a viewer hides names when anonymous or a guest. All must read a missing user
// (anonymous, or no provider) as no capability rather than throwing.
describe('canParticipate', () => {
  it('is true for admin and normal, false otherwise', () => {
    expect(canParticipate(signedInMe('u', 'admin'))).toBe(true)
    expect(canParticipate(signedInMe('u', 'normal'))).toBe(true)
    expect(canParticipate(signedInMe('u', 'guest'))).toBe(false)
    expect(canParticipate(signedInMe('u', 'pending'))).toBe(false)
    expect(canParticipate(anonymousMe)).toBe(false)
    expect(canParticipate(null)).toBe(false)
  })
})

describe('canPlay', () => {
  it('is true for admin, normal, and guest, false for pending and anonymous', () => {
    expect(canPlay(signedInMe('u', 'admin'))).toBe(true)
    expect(canPlay(signedInMe('u', 'normal'))).toBe(true)
    expect(canPlay(signedInMe('u', 'guest'))).toBe(true)
    expect(canPlay(signedInMe('u', 'pending'))).toBe(false)
    expect(canPlay(anonymousMe)).toBe(false)
    expect(canPlay(null)).toBe(false)
  })
})

describe('hidesNames', () => {
  it('is true for a guest and an anonymous (or unresolved) viewer, false for signed-in participants', () => {
    expect(hidesNames(signedInMe('u', 'admin'))).toBe(false)
    expect(hidesNames(signedInMe('u', 'normal'))).toBe(false)
    expect(hidesNames(signedInMe('u', 'pending'))).toBe(false)
    expect(hidesNames(signedInMe('u', 'guest'))).toBe(true)
    expect(hidesNames(anonymousMe)).toBe(true)
    expect(hidesNames(null)).toBe(true)
  })
})

describe('isAdmin', () => {
  it('is true only for admin', () => {
    expect(isAdmin(signedInMe('u', 'admin'))).toBe(true)
    expect(isAdmin(signedInMe('u', 'normal'))).toBe(false)
    expect(isAdmin(signedInMe('u', 'guest'))).toBe(false)
    expect(isAdmin(signedInMe('u', 'pending'))).toBe(false)
    expect(isAdmin(anonymousMe)).toBe(false)
    expect(isAdmin(null)).toBe(false)
  })
})
