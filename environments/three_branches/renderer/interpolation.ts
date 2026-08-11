/** Pure interpolation between decoded overlay endpoints for ticker-driven playback. */
import { lerp } from '@renderers/base/math.js'

import type { Character, DynamicOverlay } from './overlay.js'
import { PRESENTATION } from './presentation.js'

/** Scale the renderer-local natural tick duration to the host's playback cadence. */
export function transitionDurationMs(transitionScale: number): number {
  return PRESENTATION.timing.tickTransitionMs * transitionScale
}

/**
 * How long one tick's motion should take.
 *
 * A paced host declares its cadence through `transitionScale`, and that is the answer. An unpaced
 * one, which is what live human play in a realtime village gets, declares nothing at all, so the
 * natural one-second tick would be four times the quarter-second the harness actually steps at and
 * the cast would trail three ticks behind wherever it really is. The measured gap since the previous
 * state is the honest duration there. It is smoothed so ordinary arrival jitter does not make the
 * village visibly speed up and slow down, and capped at the natural duration so a long stall resumes
 * at walking pace rather than crawling.
 */
export function transitionDurationFor(
  transitionScale: number | undefined,
  arrivalMs: number | null,
): number {
  if (transitionScale !== undefined && Number.isFinite(transitionScale) && transitionScale >= 0) {
    return transitionDurationMs(transitionScale)
  }
  const natural = transitionDurationMs(1)
  if (arrivalMs === null || arrivalMs <= 0) return natural
  return Math.min(natural, arrivalMs)
}

/** Fold one arrival gap into the running estimate an unpaced host is paced by. */
export function smoothedArrivalMs(previous: number | null, gapMs: number): number {
  return previous === null ? gapMs : previous * 0.7 + gapMs * 0.3
}

/** Linear progress preserves velocity when consecutive decoded steps continue in one direction. */
export function interpolationProgress(elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0 || elapsedMs >= durationMs) return 1
  if (elapsedMs <= 0) return 0
  return elapsedMs / durationMs
}

/** Build one deterministic in-between overlay without mutating either decoded endpoint. */
export function interpolateDynamicOverlay(
  from: DynamicOverlay,
  to: DynamicOverlay,
  progress: number,
): DynamicOverlay {
  if (progress <= 0) return from
  if (progress >= 1) return to
  const beforeById = new Map(from.characters.map((character) => [character.id, character]))
  return {
    ...to,
    tick: lerp(from.tick, to.tick, progress),
    characters: to.characters.map((character) =>
      interpolateCharacter(beforeById.get(character.id), character, progress),
    ),
  }
}

function interpolateCharacter(
  from: Character | undefined,
  to: Character,
  progress: number,
): Character {
  if (from === undefined) return to
  return {
    ...to,
    position: {
      x: lerp(from.position.x, to.position.x, progress),
      y: lerp(from.position.y, to.position.y, progress),
    },
    heading: interpolateHeading(from.heading, to.heading, progress),
    moved: Math.max(from.moved, to.moved),
  }
}

function interpolateHeading(from: number, to: number, progress: number): number {
  const delta = ((((to - from) % 360) + 540) % 360) - 180
  const heading = (from + delta * progress) % 360
  return heading < 0 ? heading + 360 : heading
}
