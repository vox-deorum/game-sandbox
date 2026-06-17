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
