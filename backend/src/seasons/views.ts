/**
 * Wire-shape helpers for seasons and runs.
 *
 * The storage rows carry their nested documents as JSON text (`seasons.config`, a run's
 * `config_snapshot`/`submission_snapshot`, a scheduled game's `seats`). The admin and public routes
 * return them decoded where configuration is part of the response, so a client reads structured
 * config rather than re-parsing strings. The separate public season-index helper deliberately omits
 * configuration and rating prompts.
 */

import type { BoardAgentRef } from '@game-sandbox/schema/board'
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'

import { enrichAgentRef } from '../auth/users.js'
import {
  type AgentRef,
  AgentRefArraySchema,
  type PublicSeason,
  type Season,
  type SeasonRun,
  type SeasonRunGame,
} from '../storage/schema.js'
import { decodeSeasonConfig, type SeasonConfig } from '../storage/season-config.js'
import { optionalField } from '../util/optional-field.js'

/** No names resolved: the enrichment no-op the builders default to when a caller passes none. */
const NO_NAMES: ReadonlyMap<string, string> = new Map()

// A run's roster and each game's seats are JSON columns the routes decode twice: once to collect owner
// ids for the batched name lookup, then again to build the view. Memoize the parse per row object (the
// same instances flow through both passes) so the decode — the single place `AgentRef` JSON is read —
// happens once. Entries are dropped when the row is unreferenced, so this holds no rows alive.
const seatsCache = new WeakMap<SeasonRunGame, AgentRef[]>()
const snapshotCache = new WeakMap<SeasonRun, AgentRef[]>()

/** Decode and validate one persisted array of canonical agent references. */
function decodeAgentRefs(text: string, field: string): AgentRef[] {
  const parsed: unknown = JSON.parse(text)
  const result = AgentRefArraySchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`stored ${field} must be an array of valid agent references`)
  }
  return result.data
}

/** Decode a scheduled game's `seats` JSON once per row object. */
function decodeSeats(game: SeasonRunGame): AgentRef[] {
  const cached = seatsCache.get(game)
  if (cached !== undefined) {
    return cached
  }
  const seats = decodeAgentRefs(game.seats, 'season run game seats')
  seatsCache.set(game, seats)
  return seats
}

/** Decode a run's frozen `submission_snapshot` JSON once per row object. */
function decodeSnapshot(run: SeasonRun): AgentRef[] {
  const cached = snapshotCache.get(run)
  if (cached !== undefined) {
    return cached
  }
  const snapshot = decodeAgentRefs(run.submission_snapshot, 'season run submission snapshot')
  if (snapshot.some((ref) => ref.kind !== 'submission')) {
    throw new Error('stored season run submission snapshot must contain only submissions')
  }
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
  | 'description_markdown'
  | 'template_repo_url'
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
    description_markdown: season.description_markdown,
    template_repo_url: season.template_repo_url,
    created_at: season.created_at,
    released_at: season.released_at,
    submission_count: season.submission_count,
    game_count: season.game_count,
  }
}

/** A scheduled game with its `seats` JSON decoded into resolved {@link BoardAgentRef}s. */
export type RunGameView = Omit<SeasonRunGame, 'seats'> & { seats: BoardAgentRef[] }

/**
 * Decode a scheduled game's `seats` JSON for the wire, attaching owner display names when resolved
 * and, when the caller passes the game's environment metadata, each built-in seat's declared label.
 */
export function runGameView(
  game: SeasonRunGame,
  names: ReadonlyMap<string, string> = NO_NAMES,
  meta?: EnvironmentMeta,
): RunGameView {
  return { ...game, seats: decodeSeats(game).map((seat) => enrichAgentRef(seat, names, meta)) }
}

/** A run with its frozen snapshots decoded and its scheduled games attached, for the admin status view. */
export type RunView = Omit<SeasonRun, 'config_snapshot' | 'submission_snapshot'> & {
  /** The requester's display name, when the directory resolved one (omitted otherwise). */
  requested_by_name?: string
  config_snapshot: SeasonConfig
  submission_snapshot: BoardAgentRef[]
  games: RunGameView[]
}

/**
 * Decode a run's snapshots and attach its (already-ordered) scheduled games. `meta`, when passed,
 * carries the run's environment's declared built-in labels through to every enriched agent ref.
 */
export function runView(
  run: SeasonRun,
  games: SeasonRunGame[],
  names: ReadonlyMap<string, string> = NO_NAMES,
  meta?: EnvironmentMeta,
): RunView {
  return {
    ...run,
    ...optionalField('requested_by_name', names.get(run.requested_by)),
    config_snapshot: decodeSeasonConfig(run.config_snapshot),
    submission_snapshot: decodeSnapshot(run).map((ref) => enrichAgentRef(ref, names, meta)),
    games: games.map((game) => runGameView(game, names, meta)),
  }
}

/**
 * A run as the admin runs-list reads it: the run row's identity, status, timestamps, and error plus a
 * game count. Every frozen snapshot (config, roster, parameters) is dropped, because the list does not
 * need them and a single run's details endpoint serves the full {@link RunView} when one is opened.
 * Adding a snapshot column means adding it here too, or the list silently starts shipping it.
 */
export type RunSummaryView = Omit<
  SeasonRun,
  'config_snapshot' | 'submission_snapshot' | 'parameters_snapshot'
> & {
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
  const {
    config_snapshot: _config,
    submission_snapshot: _submissions,
    parameters_snapshot: _parameters,
    ...rest
  } = run
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

/** Every submission owner id seated in a list of scheduled games (their `seats` are JSON-encoded). */
export function gameOwnerIds(games: readonly SeasonRunGame[]): string[] {
  return games.flatMap((game) => agentOwnerIds(decodeSeats(game)))
}

/**
 * Every submission owner id in a run's frozen roster and its scheduled games — the one call the
 * routes batch their name lookup from before handing the same `run`/`games` to {@link runView},
 * rather than each inlining its own `agentOwnerIds(...) + gameOwnerIds(...)` pair.
 */
export function ownerIdsForRun(run: SeasonRun, games: readonly SeasonRunGame[]): string[] {
  return [...agentOwnerIds(decodeSnapshot(run)), ...gameOwnerIds(games)]
}
