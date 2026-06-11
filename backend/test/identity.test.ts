import { describe, expect, it } from 'vitest'

import { DEV_USER_ID, resolveUserId } from '../src/identity.js'

describe('resolveUserId', () => {
  it('returns the x-sandbox-user header when present', () => {
    expect(resolveUserId({ 'x-sandbox-user': 'alice' })).toBe('alice')
  })

  it('falls back to dev-user when the header is absent', () => {
    expect(resolveUserId({})).toBe(DEV_USER_ID)
  })

  it('falls back to dev-user when the header is blank', () => {
    expect(resolveUserId({ 'x-sandbox-user': '   ' })).toBe(DEV_USER_ID)
  })

  it('uses the first value when the header arrives as an array', () => {
    expect(resolveUserId({ 'x-sandbox-user': ['bob', 'carol'] })).toBe('bob')
  })
})
