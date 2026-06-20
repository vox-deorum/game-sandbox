/**
 * Wire-shape helpers for seasons and runs.
 *
 * The storage rows carry their nested documents as JSON text (`seasons.config`, a run's
 * `config_snapshot`/`submission_snapshot`, a scheduled game's `slots`). The admin and public routes
 * return them decoded where configuration is part of the response, so a client reads structured
 * config rather than re-parsing strings. The separate public season-index helper deliberately omits
 * configuration and rating prompts.
 */

import type { AgentRef, Season, SeasonRun, SeasonRunGame } from './storage/schema.js'
import { decodeSeasonConfig, type SeasonConfig } from './storage/season-config.js'

/** A season row with its `config` column decoded into the structured {@link SeasonConfig}. */
export type SeasonView = Omit<Season, 'config'> & { config: SeasonConfig }

/** Decode a season's `config` JSON for the wire. */
export function seasonView(season: Season): SeasonView {
  return { ...season, config: decodeSeasonConfig(season.config) }
}

/** The public season-list shape, intentionally excluding config and rating prompts. */
export type PublicSeasonView = Pick<
  Season,
  | 'id'
  | 'env_id'
  | 'submission_status'
  | 'play_status'
  | 'release_status'
  | 'label'
  | 'created_at'
  | 'released_at'
>

/**
 * Return only the identity, label, public gates, and timestamps needed by public season indexes.
 * Unreleased season configuration and rating prompts remain operator-only.
 */
export function publicSeasonView(season: Season): PublicSeasonView {
  return {
    id: season.id,
    env_id: season.env_id,
    submission_status: season.submission_status,
    play_status: season.play_status,
    release_status: season.release_status,
    label: season.label,
    created_at: season.created_at,
    released_at: season.released_at,
  }
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
