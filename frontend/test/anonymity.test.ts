import { describe, expect, it } from 'vitest'

import { anonymityState, presentsMasked } from '../src/lib/anonymity.js'

describe('anonymity policy', () => {
  it('fails closed while identity, season, or player facts are unresolved', () => {
    for (const facts of [
      { identityResolved: false, seasonPlayable: true, hasSubmittedAgent: true },
      { identityResolved: true, seasonPlayable: null, hasSubmittedAgent: true },
      { identityResolved: true, seasonPlayable: true, hasSubmittedAgent: null },
    ]) {
      const state = anonymityState({ operator: false, ...facts })
      expect(state).toBe('unknown')
    }
    // Every unresolved state renders masked, not raw, so a missing fact never leaks identity.
    expect(presentsMasked('unknown')).toBe(true)
  })

  it('shows identity only when no protection applies or an operator is confirmed', () => {
    expect(
      anonymityState({
        identityResolved: false,
        operator: false,
        seasonPlayable: null,
        hasSubmittedAgent: false,
      }),
    ).toBe('visible')
    expect(
      anonymityState({
        identityResolved: true,
        operator: true,
        seasonPlayable: true,
        hasSubmittedAgent: true,
      }),
    ).toBe('visible')
  })

  it('masks a submitted agent from a non-operator during open play', () => {
    expect(
      anonymityState({
        identityResolved: true,
        operator: false,
        seasonPlayable: true,
        hasSubmittedAgent: true,
      }),
    ).toBe('masked')
  })
})
