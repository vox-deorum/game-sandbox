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
 * distinct from the flappy {@link OWNERS}. Each maps to an `examples/hearts/<name>/` agent, with
 * Oracle also exercising the season's LLM policy.
 */
export const HEARTS_OWNERS = {
  /** examples/hearts/oracle: makes calls through the season's OpenAI-compatible relay. */
  oracle: 'margaret-hamilton',
  /** examples/hearts/moonshot: tries to win every trick and shoot the moon. */
  moonshot: 'mae-jemison',
  /** examples/hearts/assassin: hunts and dumps the queen of spades. */
  assassin: 'rosalind-franklin',
  /** examples/hearts/closer: exploits the last seat in a trick. */
  closer: 'emmy-noether',
  /**
   * The owner of the single submitted seat in the per-seat replay-attribution test. Kept distinct
   * from the four matchup owners above so its `players` line in that recording is unambiguous and the
   * agent profile it leaves behind shows exactly this one submission.
   */
  replay: 'annie-easley',
} as const

/** A second participant for the Hearts season's LLM development-access checks. */
export const LLM_PERSONAS = {
  other: 'dorothy-vaughan',
} as const

/**
 * The fixed episode seed the on-screen human-seat test starts its Hearts session with. With this deal
 * `player_0` (the seat the connected human controls, drawn at the bottom of the table) holds the 2 of
 * clubs and so leads the very first trick, where only the 2♣ is legal and every other card is greyed —
 * the deterministic opening the test clicks against. Computed offline from `hearts.rules.deal`, which
 * is fully seed-driven, so it is stable across runs.
 */
export const HEARTS_HUMAN_LEAD_SEED = 0

/** The Spades environment, exercised by the browser chat journey and matchup coverage (spades.spec.ts). */
export const SPADES_ENV_ID = 'spades'

/**
 * The Spades matchup season. A distinct, card-themed label so it never collides with the flight-themed
 * flappy seasons or Hearts' {@link HEARTS_SEASON} in the shared database.
 */
export const SPADES_SEASON = 'Partnership Cup'

/**
 * The three Spades agent owners, one per example strategy submitted into the matchup. The owner id is
 * the public agent identity (the scoreboard row links to it), so these read like real handles and are
 * distinct from {@link OWNERS} and {@link HEARTS_OWNERS}. Each maps to an `examples/spades/<name>/` agent.
 */
export const SPADES_OWNERS = {
  /** examples/spades/counter: bids its hand's honest trick count and plays to make it. */
  counter: 'ada-byron',
  /** examples/spades/daredevil: hunts nil bids and bags. */
  daredevil: 'evel-knievel',
  /** examples/spades/signaler: uses its bid and early plays to signal its hand to its partner. */
  signaler: 'samuel-morse',
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
 * Agent owners. The owner handle *is* the agent's public identity — the leaderboard row links to it
 * and the profile lives at `/environments/<env>/agents/<owner>` — so these read like real handles.
 * Each is created as an active (`normal`) Better Auth member on first use through the `as(handle)`
 * fixture, so it can submit and its display name matches its handle.
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
 * The raters who score agents after a session. Each is created as an active (`normal`) member through
 * the `as(handle)` fixture, so its rating write clears `requireActive`; four raters give an agent
 * enough ratings to clear the ≥3 threshold the Human Ratings board needs before it assigns a rank.
 * None owns an agent, so none is ever refused for rating its own.
 */
export const JUDGES = [
  'devon-headwind',
  'jordan-skywatch',
  'morgan-aileron',
  'taylor-gust',
] as const

/**
 * A second member who watches a session they do not own. Created through `as(SPECTATOR)` and signed
 * into a separate browser context, so the spectator page attaches as a genuine non-owner: it sees the
 * read-only chat log and no owner controls, but never the human seat.
 */
export const SPECTATOR = 'noah-onlooker'

/**
 * A distinct second spectator, for coverage that needs two independently attached watchers at once
 * (the Spades chat journey's "does a second onlooker also never see a targeted message" check). Kept
 * distinct from {@link SPECTATOR} so their two browser sessions never collide within one test.
 */
export const SPECTATOR_TWO = 'olivia-lookout'

/** The operator's season-wide rating guidance, shown above every agent on the rating panel. */
export const OPERATOR_RATING_PROMPT =
  'Reward agents that keep the bird steady and survive the longest.'

/** One agent author's own rating guidance, shown beside their agent on the rating panel. */
export const AUTHOR_RATING_PROMPT =
  'I tuned the flap cadence for long, smooth glides — judge the gliding, not the score.'
