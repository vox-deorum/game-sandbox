/**
 * Wire-shape helpers for seasons and runs.
 *
 * The storage rows carry their nested documents as JSON text (`seasons.config`, a run's
 * `config_snapshot`/`submission_snapshot`, a scheduled game's `slots`). The admin and public routes
 * return them decoded so a client reads structured config rather than re-parsing strings. These
 * helpers are the single place that decoding happens, shared by the admin status view and the public
 * leaderboard reads so the two never drift.
 */

import type { AgentRef, Season, SeasonRun, SeasonRunGame } from './storage/schema.js'
import { decodeSeasonConfig, type SeasonConfig } from './storage/season-config.js'

/** A season row with its `config` column decoded into the structured {@link SeasonConfig}. */
export type SeasonView = Omit<Season, 'config'> & { config: SeasonConfig }

/** Decode a season's `config` JSON for the wire. */
export function seasonView(season: Season): SeasonView {
  return { ...season, config: decodeSeasonConfig(season.config) }
}

/** A scheduled game with its `slots` JSON decoded into resolved {@link AgentRef}s. */
export type RunGameView = Omit<SeasonRunGame, 'slots'> & { slots: AgentRef[] }

/** Decode a scheduled game's `slots` JSON for the wire. */
export function runGameView(game: SeasonRunGame): RunGameView {
  return { ...game, slots: JSON.parse(game.slots) as AgentRef[] }
}

/** A run with its frozen snapshots decoded and its scheduled games attached, for the admin status view. */
export type RunView = Omit<SeasonRun, 'config_snapshot' | 'submission_snapshot'> & {
  config_snapshot: SeasonConfig
  submission_snapshot: AgentRef[]
  games: RunGameView[]
}

/** Decode a run's snapshots and attach its (already-ordered) scheduled games. */
export function runView(run: SeasonRun, games: SeasonRunGame[]): RunView {
  return {
    ...run,
    config_snapshot: decodeSeasonConfig(run.config_snapshot),
    submission_snapshot: JSON.parse(run.submission_snapshot) as AgentRef[],
    games: games.map(runGameView),
  }
}
