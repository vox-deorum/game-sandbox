/**
 * The choreography of one Crane Reach event, expressed as normalized time so the host can scale the
 * whole thing by changing its cadence. At the standard 1000 ms beat the schedule runs:
 *
 * - Activation, 0 to 150 ms: the actor holds under its gilt seal before moving.
 * - Movement, 150 ms to somewhere between 500 and 750 ms: the actor walks its executed route, every
 *   entered tile taking the same slice of that span, so longer routes take longer.
 * - Settle: the actor waits at its destination until resolution begins, between 650 and 750 ms.
 * - Resolution, from that point to 1000 ms: the attack. A targeted reaction (damage, death) joins a
 *   quarter of the way in, while a capture-only reaction starts with resolution itself.
 *
 * `art-direction.md` describes what each beat looks like. This file decides when it happens.
 */
import type { RenderOptions } from '@renderers/types.js'

function cubicCoordinate(t: number, first: number, second: number): number {
  const inverse = 1 - t
  return 3 * inverse * inverse * t * first + 3 * inverse * t * t * second + t * t * t
}

/** Evaluate the host curve cubic-bezier(0.2, 0, 0, 1) at a normalized time. */
export function hostEase(time: number): number {
  const x = Math.max(0, Math.min(1, time))
  let parameter = x
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const estimate = cubicCoordinate(parameter, 0.2, 0) - x
    const inverse = 1 - parameter
    const derivative =
      3 * inverse * inverse * 0.2 + 6 * inverse * parameter * (0 - 0.2) + 3 * parameter * parameter
    if (Math.abs(estimate) < 0.00001 || Math.abs(derivative) < 0.00001) break
    parameter = Math.max(0, Math.min(1, parameter - estimate / derivative))
  }
  return cubicCoordinate(parameter, 0, 1)
}

/** Every Crane event occupies its full host cadence. */
export function eventBudget(options?: RenderOptions): number {
  return options?.transitionMs ?? 1_000
}

export interface EventTimelineProgress {
  movement: number
  attack: number
  reaction: number
}

export type EventPhase = 'idle' | 'activation' | 'movement' | 'settle' | 'resolution'

export interface EventTimelineBounds {
  activationEnd: number
  movementEnd: number
  resolutionStart: number
  reactionStart: number
}

/**
 * The beat boundaries for a route of a given length, as fractions of the event budget.
 */
export function eventTimelineBounds(movementTiles: number): EventTimelineBounds {
  const tiles = Math.max(0, Math.min(4, Math.floor(movementTiles)))
  const movementEndMs = tiles === 0 ? 150 : 500 + ((tiles - 1) * 250) / 3
  const resolutionStartMs = tiles === 0 ? 650 : 650 + ((tiles - 1) * 100) / 3
  return {
    activationEnd: 0.15,
    movementEnd: movementEndMs / 1_000,
    resolutionStart: resolutionStartMs / 1_000,
    reactionStart: resolutionStartMs / 1_000 + (1 - resolutionStartMs / 1_000) * 0.25,
  }
}

/** Keep the acting unit's movement range until resolution begins. */
export function eventRangeVisibleAt(progress: number, movementTiles: number): boolean {
  const value = Math.max(0, Math.min(1, progress))
  return value < eventTimelineBounds(movementTiles).resolutionStart
}

/** How far each of the three animated tracks has run at this point in the event. */
export function eventTimelineProgress(
  progress: number,
  hasTarget: boolean,
  hasReaction = hasTarget,
  movementTiles = 1,
): EventTimelineProgress {
  const value = Math.max(0, Math.min(1, progress))
  const bounds = eventTimelineBounds(movementTiles)
  return {
    movement: movementTiles > 0 ? phase(value, bounds.activationEnd, bounds.movementEnd) : 0,
    attack: hasTarget ? hostEase(phase(value, bounds.resolutionStart, 1)) : 0,
    reaction: hasReaction
      ? hostEase(phase(value, hasTarget ? bounds.reactionStart : bounds.resolutionStart, 1))
      : 0,
  }
}

/** Classify the current sequential phase for browser diagnostics and focused ordering tests. */
export function eventPhaseAt(
  progress: number,
  hasTarget: boolean,
  hasReaction = hasTarget,
  animating = true,
  movementTiles = 1,
): EventPhase {
  if (!animating || progress >= 1) return 'idle'
  const bounds = eventTimelineBounds(movementTiles)
  if (progress < bounds.activationEnd) return 'activation'
  if (movementTiles > 0 && progress < bounds.movementEnd) return 'movement'
  if (hasReaction && progress >= bounds.resolutionStart) return 'resolution'
  return 'settle'
}

/** Move through each entered tile in equal time, applying the host curve independently per leg. */
export function routePositionFor(
  route: ReadonlyArray<{ x: number; y: number }>,
  movementProgress: number,
): { x: number; y: number } {
  const first = route[0]
  if (first === undefined || route.length < 2) return first ?? { x: 0, y: 0 }
  const segments = route.length - 1
  const scaled = Math.max(0, Math.min(1, movementProgress)) * segments
  const index = Math.min(segments - 1, Math.floor(scaled))
  const start = route[index] as { x: number; y: number }
  const end = route[index + 1] as { x: number; y: number }
  const localProgress = scaled === segments ? 1 : scaled - index
  const eased = hostEase(localProgress)
  return { x: start.x + (end.x - start.x) * eased, y: start.y + (end.y - start.y) * eased }
}

/** Return the entered route points plus the animated actor position for a contiguous trail. */
export function routeTrailFor(
  route: ReadonlyArray<{ x: number; y: number }>,
  movementProgress: number,
): Array<{ x: number; y: number }> {
  if (route.length < 2 || movementProgress <= 0) return []
  const segments = route.length - 1
  const scaled = Math.max(0, Math.min(1, movementProgress)) * segments
  const completed = Math.min(segments, Math.floor(scaled))
  const points = route.slice(0, completed + 1).map((point) => ({ ...point }))
  if (completed < segments && scaled > completed)
    points.push(routePositionFor(route, movementProgress))
  return points
}

/** Normalize a position within one beat of the timeline, clamped outside it. */
function phase(progress: number, start: number, end: number): number {
  return Math.max(0, Math.min(1, (progress - start) / (end - start)))
}
