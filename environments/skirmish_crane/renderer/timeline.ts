/**
 * The choreography of one Crane Reach event, in absolute milliseconds. Each beat has a duration of its
 * own and the event lasts as long as its beats need, so a four-tile charge takes visibly longer than a
 * step-and-stab. The host's cadence is a minimum delivery interval, not a budget the animation is
 * squeezed into: a paced host passes its cadence relative to one second as a scale and then waits for
 * the transition to finish.
 *
 * Two tracks run at once. The attack and the reaction it provokes overlap, so a ranged shot is still
 * fading down its arc while the damage numeral and the death wisp have already begun.
 *
 * `art-direction.md` describes what each beat looks like. This file decides when it happens.
 */
import { type RenderOptions, transitionScaleOf } from '@renderers/types.js'
import { clamp } from '@renderers/base/math.js'

/** The natural duration of every beat, at scale 1. Presentation tuning starts here. */
export interface CraneTiming {
  /** The actor holds under its gilt seal before it moves. Every event has this beat. */
  activationMs: number
  /** Each tile of the executed route takes this long, so distance reads as travel time. */
  movementMsPerTile: number
  /** The lunge or the ranged arc, from the moment the actor settles on its destination. */
  attackMs: number
  /** How far into the attack the target starts reacting. */
  reactionOffsetMs: number
  /** The damage numeral, the capture bloom, and the death wisp. */
  reactionMs: number
  /** The readable pause after a controlled player's visible event. */
  humanSettleMs: number
  /** The readable pause after every other visible event. */
  watchSettleMs: number
}

export const CRANE_TIMING: CraneTiming = {
  activationMs: 200,
  movementMsPerTile: 200,
  attackMs: 400,
  reactionOffsetMs: 100,
  reactionMs: 700,
  humanSettleMs: 300,
  watchSettleMs: 200,
}

/** The unscaled pause that follows a visible event, selected when that event is installed. */
export function eventSettleDuration(actorIsControlled: boolean): number {
  return actorIsControlled ? CRANE_TIMING.humanSettleMs : CRANE_TIMING.watchSettleMs
}

/** What the schedule needs to know about an event: how far it moves, whether it strikes and provokes. */
export interface EventShape {
  movementTiles: number
  hasTarget: boolean
  hasReaction: boolean
}

/** One beat's absolute span within the event. */
export interface EventWindow {
  startMs: number
  endMs: number
}

/** Every beat of one event, already scaled, plus the total the host waits on. */
export interface EventWindows {
  activation: EventWindow
  /** Null for a stationary activation. */
  movement: EventWindow | null
  /** Null when the event hits nothing. */
  attack: EventWindow | null
  /** Null when nothing takes damage, dies, or changes a capture score. */
  reaction: EventWindow | null
  durationMs: number
}

/**
 * Lay out the beats for one event. Activation always plays; movement follows it and lasts as long as
 * the route is; an attack follows movement; a reaction joins a beat into the attack, or begins with
 * movement's end when a capture is all that happened. The event lasts until its last beat ends.
 */
export function eventWindows(shape: EventShape, scale = 1): EventWindows {
  const tiles = shape.movementTiles
  const activationEnd = CRANE_TIMING.activationMs
  const movementEnd = activationEnd + tiles * CRANE_TIMING.movementMsPerTile
  const attackEnd = movementEnd + CRANE_TIMING.attackMs
  const reactionStart = shape.hasTarget ? movementEnd + CRANE_TIMING.reactionOffsetMs : movementEnd
  const reactionEnd = reactionStart + CRANE_TIMING.reactionMs

  const activation = { startMs: 0, endMs: activationEnd }
  const movement = tiles > 0 ? { startMs: activationEnd, endMs: movementEnd } : null
  const attack = shape.hasTarget ? { startMs: movementEnd, endMs: attackEnd } : null
  const reaction = shape.hasReaction ? { startMs: reactionStart, endMs: reactionEnd } : null

  const durationMs = Math.max(
    activation.endMs,
    movement?.endMs ?? 0,
    attack?.endMs ?? 0,
    reaction?.endMs ?? 0,
  )
  return {
    activation: scaleWindow(activation, scale),
    movement: movement === null ? null : scaleWindow(movement, scale),
    attack: attack === null ? null : scaleWindow(attack, scale),
    reaction: reaction === null ? null : scaleWindow(reaction, scale),
    durationMs: durationMs * scale,
  }
}

/** The scale a caller's options ask for; a paced host passes its cadence relative to one second. */
export function eventScale(options?: RenderOptions): number {
  return transitionScaleOf(options)
}

export interface EventTimelineProgress {
  movement: number
  attack: number
  reaction: number
}

/**
 * How far each animated track has run at this point in the event. Movement is eased per route leg
 * where it is applied; attack and reaction stay linear here, so the ranged arc and the reaction fades
 * hold their brightness through the beat instead of vanishing in its first few frames.
 */
export function eventTimelineProgress(
  elapsedMs: number,
  windows: EventWindows,
): EventTimelineProgress {
  return {
    movement: windowProgress(elapsedMs, windows.movement),
    attack: windowProgress(elapsedMs, windows.attack),
    reaction: windowProgress(elapsedMs, windows.reaction),
  }
}

/**
 * The ranged arc's opacity. It runs down with the attack, so the shot is still mostly there as the
 * target begins reacting and is gone the moment the attack ends.
 */
export function rangedArcAlpha(attackProgress: number): number {
  return 1 - clamp(attackProgress, 0, 1)
}

/** The share of the reaction a numeral stays fully legible for before it begins to fade. */
const NUMERAL_HOLD = 0.65

/**
 * A rising numeral's opacity, and by inversion its rise. Damage and capture figures are the one part
 * of a reaction a viewer has to actually read, so they hold still at full strength for most of the
 * beat, then lift away and fade together over the tail.
 */
export function reactionNumeralAlpha(reactionProgress: number): number {
  const value = clamp(reactionProgress, 0, 1)
  return value <= NUMERAL_HOLD ? 1 : 1 - (value - NUMERAL_HOLD) / (1 - NUMERAL_HOLD)
}

export type EventPhase = 'idle' | 'activation' | 'movement' | 'attack' | 'reaction'

/** The latest beat to have started: the sequential reading of the event, for ordering assertions. */
export function eventPhaseAt(
  elapsedMs: number,
  windows: EventWindows,
  animating = true,
): EventPhase {
  if (!animating || elapsedMs >= windows.durationMs) return 'idle'
  if (windows.reaction !== null && elapsedMs >= windows.reaction.startMs) return 'reaction'
  if (windows.attack !== null && elapsedMs >= windows.attack.startMs) return 'attack'
  if (windows.movement !== null && elapsedMs >= windows.movement.startMs) return 'movement'
  return 'activation'
}

/** Every beat currently inside its own window, so the overlap between attack and reaction is visible. */
export function eventActiveTracks(elapsedMs: number, windows: EventWindows): EventPhase[] {
  const tracks: EventPhase[] = []
  if (within(elapsedMs, windows.activation)) tracks.push('activation')
  if (within(elapsedMs, windows.movement)) tracks.push('movement')
  if (within(elapsedMs, windows.attack)) tracks.push('attack')
  if (within(elapsedMs, windows.reaction)) tracks.push('reaction')
  return tracks
}

/** Keep the acting unit's range until it strikes or takes ground; a plain move keeps it throughout. */
export function eventRangeVisibleAt(elapsedMs: number, windows: EventWindows): boolean {
  const clearAt = windows.attack?.startMs ?? windows.reaction?.startMs
  return clearAt === undefined || elapsedMs < clearAt
}

function cubicCoordinate(t: number, first: number, second: number): number {
  const inverse = 1 - t
  return 3 * inverse * inverse * t * first + 3 * inverse * t * t * second + t * t * t
}

/** Evaluate the host curve cubic-bezier(0.2, 0, 0, 1) at a normalized time. */
export function hostEase(time: number): number {
  const x = clamp(time, 0, 1)
  let parameter = x
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const estimate = cubicCoordinate(parameter, 0.2, 0) - x
    const inverse = 1 - parameter
    const derivative =
      3 * inverse * inverse * 0.2 + 6 * inverse * parameter * (0 - 0.2) + 3 * parameter * parameter
    if (Math.abs(estimate) < 0.00001 || Math.abs(derivative) < 0.00001) break
    parameter = clamp(parameter - estimate / derivative, 0, 1)
  }
  return cubicCoordinate(parameter, 0, 1)
}

/** Move through each entered tile in equal time, applying the host curve independently per leg. */
export function routePositionFor(
  route: ReadonlyArray<{ x: number; y: number }>,
  movementProgress: number,
): { x: number; y: number } {
  const first = route[0]
  if (first === undefined || route.length < 2) return first ?? { x: 0, y: 0 }
  const segments = route.length - 1
  const scaled = clamp(movementProgress, 0, 1) * segments
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
  const scaled = clamp(movementProgress, 0, 1) * segments
  const completed = Math.min(segments, Math.floor(scaled))
  const points = route.slice(0, completed + 1).map((point) => ({ ...point }))
  if (completed < segments && scaled > completed)
    points.push(routePositionFor(route, movementProgress))
  return points
}

function scaleWindow(window: EventWindow, scale: number): EventWindow {
  return { startMs: window.startMs * scale, endMs: window.endMs * scale }
}

/** A beat that does not exist has not run; one collapsed to an instant is done as soon as it starts. */
function windowProgress(elapsedMs: number, window: EventWindow | null): number {
  if (window === null) return 0
  if (window.endMs <= window.startMs) return elapsedMs >= window.startMs ? 1 : 0
  const span = (elapsedMs - window.startMs) / (window.endMs - window.startMs)
  return clamp(span, 0, 1)
}

function within(elapsedMs: number, window: EventWindow | null): boolean {
  return window !== null && elapsedMs >= window.startMs && elapsedMs < window.endMs
}
