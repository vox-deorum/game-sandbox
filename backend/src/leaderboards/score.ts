/**
 * The per-environment episode-score normalization seam.
 *
 * The automated board ranks agents by a leaderboard score that is always **higher-is-better**, so the
 * board math never carries a per-environment "which direction wins" assumption. The mapping from an
 * environment's raw final score to that normalized score belongs to the environment, per
 * [leaderboard.md](../../../docs/specs/leaderboard.md), so it lives behind this one function rather
 * than being scattered through the runner and the board.
 *
 * Flappy Bird is the only environment this stage and is already higher-is-better, so its mapping is
 * the identity. A future lower-is-better environment (a "fewest moves" or "lowest time" game) supplies
 * its own mapping here — for example `-raw` or `1 / (1 + raw)` — without touching the board ranking.
 */

/** Normalize an environment's raw final episode score to the higher-is-better leaderboard score. */
export function normalizeEpisodeScore(_envId: string, rawFinalScore: number): number {
  // Identity for every environment this stage; Flappy Bird's score is already higher-is-better.
  return rawFinalScore
}

/**
 * The normalized leaderboard score a *forfeited* game contributes: a game a seat did not finish
 * cleanly (its agent crashed, played an illegal move, or overran its budget; or the whole container
 * faulted with no identifiable culprit).
 *
 * A forfeit must never out-score honest play, or failing becomes a strategy. A terminal-scored
 * environment makes this acute: Hearts pays its (negative) penalty only at the final trick, so a seat
 * that aborts early has a partial score of ~0 — the *best* possible Hearts score — and would top the
 * board despite failing every game. So a forfeit takes the environment's worst achievable normalized
 * score instead of its partial one, the floor below every honest outcome:
 *
 *   * Hearts: a single hand is worth at most 26 penalty points (all hearts + the Queen, with the
 *     shoot-the-moon flip capping it), so the worst leaderboard score is `-26`.
 *   * Spades: a partnership's worst single-hand score is `-260` (both partners bid 13, an unmakeable
 *     26-trick contract set for `-10 * 26`), and a seat is ranked by its team's score, so that is the
 *     floor below every honest team outcome.
 *   * Flappy Bird: the score accrues upward from zero as pipes are passed, so honest play already
 *     ranks an early failure near the bottom; zero (no progress) is its forfeit floor.
 *
 * A new environment must register its floor here, exactly as it would register a non-identity mapping
 * in {@link normalizeEpisodeScore}; the `0` default suits an upward-accruing score but would
 * under-penalize a forfeit in a future negative or lower-is-better environment.
 */
export function forfeitScore(envId: string): number {
  switch (envId) {
    case 'hearts':
      return -26
    case 'spades':
      return -260
    default:
      return 0
  }
}
