/**
 * Wire-shape helpers for iterations and runs.
 *
 * The storage rows carry their nested documents as JSON text (`iterations.config`, a run's
 * `config_snapshot`/`submission_snapshot`, a scheduled game's `slots`). The admin and public routes
 * return them decoded so a client reads structured config rather than re-parsing strings. These
 * helpers are the single place that decoding happens, shared by the admin status view and the public
 * leaderboard reads so the two never drift.
 */
import { decodeIterationConfig, type IterationConfig } from './storage/iteration-config.js'
import type { AgentRef, Iteration, IterationRun, IterationRunGame } from './storage/schema.js'

/** An iteration row with its `config` column decoded into the structured {@link IterationConfig}. */
export type IterationView = Omit<Iteration, 'config'> & { config: IterationConfig }

/** Decode an iteration's `config` JSON for the wire. */
export function iterationView(iteration: Iteration): IterationView {
  return { ...iteration, config: decodeIterationConfig(iteration.config) }
}

/** A scheduled game with its `slots` JSON decoded into resolved {@link AgentRef}s. */
export type RunGameView = Omit<IterationRunGame, 'slots'> & { slots: AgentRef[] }

/** Decode a scheduled game's `slots` JSON for the wire. */
export function runGameView(game: IterationRunGame): RunGameView {
  return { ...game, slots: JSON.parse(game.slots) as AgentRef[] }
}

/** A run with its frozen snapshots decoded and its scheduled games attached, for the admin status view. */
export type RunView = Omit<IterationRun, 'config_snapshot' | 'submission_snapshot'> & {
  config_snapshot: IterationConfig
  submission_snapshot: AgentRef[]
  games: RunGameView[]
}

/** Decode a run's snapshots and attach its (already-ordered) scheduled games. */
export function runView(run: IterationRun, games: IterationRunGame[]): RunView {
  return {
    ...run,
    config_snapshot: decodeIterationConfig(run.config_snapshot),
    submission_snapshot: JSON.parse(run.submission_snapshot) as AgentRef[],
    games: games.map(runGameView),
  }
}
