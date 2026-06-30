/**
 * The meaningful identities every spec shares. Because each run starts from a fresh database (see
 * e2e/fresh-backend.mjs), names no longer need a timestamp to stay unique — they can read like real
 * data instead. This also shapes the demo site, which serves the `main` e2e database as its fixture
 * (see scripts/demo.py): a leaderboard of `ada-lovelace` vs `grace-hopper` beats one of `e2e-good-1718…`.
 *
 * Keep season labels distinct per spec: the whole suite shares one database within a run, so two
 * seasons with the same label would make label-based assertions ambiguous.
 */

export const ENV_ID = 'flappy_bird'

/** The Hearts environment, exercised by the dedicated multi-seat matchup spec (hearts.spec.ts). */
export const HEARTS_ENV_ID = 'hearts'

/**
 * The Hearts matchup season. A distinct, card-themed label (the "Black Lady" is a nickname for the
 * queen of spades) so it never collides with the flight-themed flappy seasons in the shared database.
 */
export const HEARTS_SEASON = 'Black Lady Open'

/**
 * The four Hearts agent owners, one per example strategy submitted into the matchup. The owner id is
 * the public agent identity (the scoreboard row links to it), so these read like real handles and are
 * distinct from the flappy {@link OWNERS}. Each maps to an `examples/hearts/<name>/` agent.
 */
export const HEARTS_OWNERS = {
  /** examples/hearts/duck — avoids taking points. */
  duck: 'katherine-johnson',
  /** examples/hearts/moonshot — tries to win every trick and shoot the moon. */
  moonshot: 'mae-jemison',
  /** examples/hearts/assassin — hunts and dumps the queen of spades. */
  assassin: 'rosalind-franklin',
  /** examples/hearts/closer — exploits the last seat in a trick. */
  closer: 'emmy-noether',
} as const

/** Season labels — short, no year, themed on flight. One per spec/test that declares a season. */
export const SEASONS = {
  /** The leaderboards arc: a full competition (submissions → run → ratings → release). */
  competition: 'Updraft Open',
  /** The released-season card on the cross-game Seasons index. */
  releasedCard: 'Thermals Cup',
  /** The two released seasons the history test walks between. */
  historyOlder: 'Crosswind Open',
  historyNewer: 'Tailwind Classic',
  /** An unreleased season only the operator's history shows. */
  operatorPreview: 'Gale Trials',
} as const

/**
 * Agent owners. The owner id *is* the agent's public identity — the leaderboard row links to it and
 * the profile lives at `/environments/<env>/agents/<owner>` — so these read like real handles. Owners
 * need not be allowlisted: submitting an agent does not gate on the session allowlist.
 */
export const OWNERS = {
  /** Glides on a long flap cadence; tuned for a steady, high-rated run in the leaderboards arc. */
  glider: 'ada-lovelace',
  /** Flaps eagerly (leaderboards arc). */
  flapper: 'grace-hopper',
  /** Never flaps — the lowest-rated of the three (leaderboards arc). */
  drifter: 'alan-turing',
  /**
   * The submission-pipeline detail test's good agent. Kept distinct from the arc owners above so the
   * `/agents/<owner>` profile shows exactly one submission and its per-stage timeline is unambiguous.
   */
  pipeline: 'maya-fledgling',
  /** Submits an agent whose manifest names a class it never defines; used by the load-failure test. */
  faulty: 'casey-faultline',
} as const

/**
 * The raters who score agents after a session. They must be on the `main` backend's session allowlist
 * (set in playwright.config.ts); four raters give an agent enough ratings to clear the ≥3 threshold the
 * Human Ratings board needs before it assigns a rank. None of them owns an agent, so none is ever
 * refused for rating its own.
 */
export const JUDGES = ['dev-user', 'jordan-skywatch', 'morgan-aileron', 'taylor-gust'] as const

/** A second identity that watches a session it does not own; deliberately not on any allowlist. */
export const SPECTATOR = 'noah-onlooker'

/** The operator's season-wide rating guidance, shown above every agent on the rating panel. */
export const OPERATOR_RATING_PROMPT =
  'Reward agents that keep the bird steady and survive the longest.'

/** One agent author's own rating guidance, shown beside their agent on the rating panel. */
export const AUTHOR_RATING_PROMPT =
  'I tuned the flap cadence for long, smooth glides — judge the gliding, not the score.'
