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

/**
 * The cadence (ms) at which a live human session should pace the *other* players' moves, so a burst
 * of fast AI replies animates one at a time rather than snapping together. Read straight from the
 * environment's `live_interval_ms`; `null` (a realtime env, or any env that does not set it) means
 * "render every frame on arrival" — the human session's default, unbuffered behaviour.
 */
export function liveIntervalMs(meta: EnvironmentMeta | null | undefined): number | null {
  return meta?.live_interval_ms ?? null
}
