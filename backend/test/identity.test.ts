import { describe, expect, it } from 'vitest'

import { DEV_USER_ID, isAllowlisted, isOperator, resolveUserId } from '../src/identity.js'

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

  it('takes the WS user query parameter when the header is absent', () => {
    expect(resolveUserId({}, { user: 'alice' })).toBe('alice')
  })

  it('prefers the header over the query parameter', () => {
    expect(resolveUserId({ 'x-sandbox-user': 'header' }, { user: 'query' })).toBe('header')
  })

  it('falls through a blank header to the query parameter', () => {
    expect(resolveUserId({ 'x-sandbox-user': '  ' }, { user: 'alice' })).toBe('alice')
  })

  it('falls back to dev-user when neither header nor query names a user', () => {
    expect(resolveUserId({}, {})).toBe(DEV_USER_ID)
    expect(resolveUserId({}, { user: '   ' })).toBe(DEV_USER_ID)
  })
})

describe('isAllowlisted', () => {
  it('is true only for ids on the allowlist', () => {
    expect(isAllowlisted('alice', ['alice', 'bob'])).toBe(true)
    expect(isAllowlisted('mallory', ['alice', 'bob'])).toBe(false)
    expect(isAllowlisted('alice', [])).toBe(false)
  })
})

describe('isOperator', () => {
  it('resolves the dev mock user as operator under the default allowlist', () => {
    expect(isOperator(DEV_USER_ID, [DEV_USER_ID])).toBe(true)
  })

  it('honors a configured operator allowlist and rejects everyone else', () => {
    expect(isOperator('alice', ['alice', 'bob'])).toBe(true)
    expect(isOperator('mallory', ['alice', 'bob'])).toBe(false)
    expect(isOperator('alice', [])).toBe(false)
  })
})
