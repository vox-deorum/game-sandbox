/**
 * The cadence (ms) at which watch and replay play a frame out, derived from an environment's metadata.
 *
 * A realtime environment paces by its step interval (`pace_interval_ms`); a turn-based one (Hearts)
 * has no step interval but may declare a `view_interval_ms` so a spectator can follow each move at a
 * watchable speed. `null` means neither is set, and the caller falls back to its own default viewing
 * cadence (the replay transport and the live watch buffer each carry one).
 */
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'

export function playbackIntervalMs(meta: EnvironmentMeta | null | undefined): number | null {
  return meta?.pace_interval_ms ?? meta?.view_interval_ms ?? null
}
