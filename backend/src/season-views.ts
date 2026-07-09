/**
 * Wire-shape helpers for seasons and runs.
 *
 * The storage rows carry their nested documents as JSON text (`seasons.config`, a run's
 * `config_snapshot`/`submission_snapshot`, a scheduled game's `slots`). The admin and public routes
 * return them decoded where configuration is part of the response, so a client reads structured
 * config rather than re-parsing strings. The separate public season-index helper deliberately omits
 * configuration and rating prompts.
 */

import type { BoardAgentRef } from '@game-sandbox/schema/board'

import { enrichAgentRef } from './auth/users.js'
import { optionalField } from './optional-field.js'
import type { AgentRef, PublicSeason, Season, SeasonRun, SeasonRunGame } from './storage/schema.js'
import { decodeSeasonConfig, type SeasonConfig } from './storage/season-config.js'

/** No names resolved: the enrichment no-op the builders default to when a caller passes none. */
const NO_NAMES: ReadonlyMap<string, string> = new Map()

// A run's roster and each game's slots are JSON columns the routes decode twice: once to collect owner
// ids for the batched name lookup, then again to build the view. Memoize the parse per row object (the
// same instances flow through both passes) so the decode — the single place `AgentRef` JSON is read —
// happens once. Entries are dropped when the row is unreferenced, so this holds no rows alive.
const slotsCache = new WeakMap<SeasonRunGame, AgentRef[]>()
const snapshotCache = new WeakMap<SeasonRun, AgentRef[]>()

/** Decode a scheduled game's `slots` JSON once per row object. */
function decodeSlots(game: SeasonRunGame): AgentRef[] {
  const cached = slotsCache.get(game)
  if (cached !== undefined) {
    return cached
  }
  const slots = JSON.parse(game.slots) as AgentRef[]
  slotsCache.set(game, slots)
  return slots
}

/** Decode a run's frozen `submission_snapshot` JSON once per row object. */
function decodeSnapshot(run: SeasonRun): AgentRef[] {
  const cached = snapshotCache.get(run)
  if (cached !== undefined) {
    return cached
  }
  const snapshot = JSON.parse(run.submission_snapshot) as AgentRef[]
  snapshotCache.set(run, snapshot)
  return snapshot
}

/** A season row with its `config` column decoded into the structured {@link SeasonConfig}. */
export type SeasonView = Omit<Season, 'config'> & { config: SeasonConfig }

/** Decode a season's `config` JSON for the wire. */
export function seasonView(season: Season): SeasonView {
  return { ...season, config: decodeSeasonConfig(season.config) }
}

/** The public season-list shape, intentionally excluding config and rating prompts. */
export type PublicSeasonView = Pick<
  PublicSeason,
  | 'id'
  | 'env_id'
  | 'submission_status'
  | 'play_status'
  | 'release_status'
  | 'label'
  | 'created_at'
  | 'released_at'
  | 'submission_count'
  | 'game_count'
>

/**
 * Return only the identity, label, public gates, timestamps, and aggregate activity counts needed by
 * public season indexes. Unreleased season configuration and rating prompts remain operator-only.
 */
export function publicSeasonView(season: PublicSeason): PublicSeasonView {
  return {
    id: season.id,
    env_id: season.env_id,
    submission_status: season.submission_status,
    play_status: season.play_status,
    release_status: season.release_status,
    label: season.label,
    created_at: season.created_at,
    released_at: season.released_at,
    submission_count: season.submission_count,
    game_count: season.game_count,
  }
}

/** A scheduled game with its `slots` JSON decoded into resolved {@link BoardAgentRef}s. */
export type RunGameView = Omit<SeasonRunGame, 'slots'> & { slots: BoardAgentRef[] }

/** Decode a scheduled game's `slots` JSON for the wire, attaching owner display names when resolved. */
export function runGameView(
  game: SeasonRunGame,
  names: ReadonlyMap<string, string> = NO_NAMES,
): RunGameView {
  return { ...game, slots: decodeSlots(game).map((slot) => enrichAgentRef(slot, names)) }
}

/** A run with its frozen snapshots decoded and its scheduled games attached, for the admin status view. */
export type RunView = Omit<SeasonRun, 'config_snapshot' | 'submission_snapshot'> & {
  /** The requester's display name, when the directory resolved one (omitted otherwise). */
  requested_by_name?: string
  config_snapshot: SeasonConfig
  submission_snapshot: BoardAgentRef[]
  games: RunGameView[]
}

/** Decode a run's snapshots and attach its (already-ordered) scheduled games. */
export function runView(
  run: SeasonRun,
  games: SeasonRunGame[],
  names: ReadonlyMap<string, string> = NO_NAMES,
): RunView {
  return {
    ...run,
    ...optionalField('requested_by_name', names.get(run.requested_by)),
    config_snapshot: decodeSeasonConfig(run.config_snapshot),
    submission_snapshot: decodeSnapshot(run).map((ref) => enrichAgentRef(ref, names)),
    games: games.map((game) => runGameView(game, names)),
  }
}

/**
 * A run as the admin runs-list reads it: the run row's identity, status, timestamps, and error plus a
 * game count, with the frozen config/roster snapshots intentionally dropped — the list does not need
 * them, and a single run's details endpoint serves the full {@link RunView} when one is opened.
 */
export type RunSummaryView = Omit<SeasonRun, 'config_snapshot' | 'submission_snapshot'> & {
  /** The requester's display name, when the directory resolved one (omitted otherwise). */
  requested_by_name?: string
  game_count: number
}

/** Strip a run's snapshots and attach its game count for the runs-list summary. */
export function runSummaryView(
  run: SeasonRun,
  gameCount: number,
  names: ReadonlyMap<string, string> = NO_NAMES,
): RunSummaryView {
  const { config_snapshot: _config, submission_snapshot: _submissions, ...rest } = run
  return {
    ...rest,
    ...optionalField('requested_by_name', names.get(run.requested_by)),
    game_count: gameCount,
  }
}

/** The submission owner ids in a list of agent refs (the Naive baseline has none). */
export function agentOwnerIds(refs: readonly AgentRef[]): string[] {
  return refs.flatMap((ref) => (ref.kind === 'submission' ? [ref.user_id] : []))
}

/** Every submission owner id seated in a list of scheduled games (their `slots` are JSON-encoded). */
export function gameOwnerIds(games: readonly SeasonRunGame[]): string[] {
  return games.flatMap((game) => agentOwnerIds(decodeSlots(game)))
}

/**
 * Every submission owner id in a run's frozen roster and its scheduled games — the one call the
 * routes batch their name lookup from before handing the same `run`/`games` to {@link runView},
 * rather than each inlining its own `agentOwnerIds(...) + gameOwnerIds(...)` pair.
 */
export function ownerIdsForRun(run: SeasonRun, games: readonly SeasonRunGame[]): string[] {
  return [...agentOwnerIds(decodeSnapshot(run)), ...gameOwnerIds(games)]
}
