/** Attribution policy while identity, season, and recording facts settle. */
export type AnonymityState = 'unknown' | 'masked' | 'visible'

export interface AnonymityFacts {
  identityResolved: boolean
  operator: boolean
  seasonPlayable: boolean | null
  hasSubmittedAgent: boolean | null
  /** A guest or anonymous viewer, who never sees real names on any recording. */
  viewerMasked: boolean
}

/** Resolve complete facts without conflating an unresolved policy with a confirmed mask. */
export function anonymityState(facts: AnonymityFacts): AnonymityState {
  // A masked viewer hides names on every recording, submitted agent or not, regardless of the play
  // window; an unresolved identity still fails closed as unknown.
  if (facts.viewerMasked) {
    return facts.identityResolved ? 'masked' : 'unknown'
  }
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
