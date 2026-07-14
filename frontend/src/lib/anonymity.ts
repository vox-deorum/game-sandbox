/** Attribution policy while identity, season, and recording facts settle. */
export type AnonymityState = 'unknown' | 'masked' | 'visible'

export interface AnonymityFacts {
  identityResolved: boolean
  operator: boolean
  seasonPlayable: boolean | null
  hasSubmittedAgent: boolean | null
}

/** Resolve complete facts without conflating an unresolved policy with a confirmed mask. */
export function anonymityState(facts: AnonymityFacts): AnonymityState {
  if (facts.hasSubmittedAgent === false || facts.seasonPlayable === false) return 'visible'
  if (
    !facts.identityResolved ||
    facts.seasonPlayable === null ||
    facts.hasSubmittedAgent === null
  ) {
    return 'unknown'
  }
  return facts.operator ? 'visible' : 'masked'
}

/** Unknown attribution fails closed until the facts prove it visible. */
export function presentsMasked(state: AnonymityState): boolean {
  return state !== 'visible'
}
