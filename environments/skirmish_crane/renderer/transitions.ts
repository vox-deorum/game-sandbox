/**
 * Whether an incoming state animates, and what the animation borrows from the frame before it.
 *
 * The renderer is a pure function of the state it is given, so anything an event needs from the
 * past has to be captured deliberately: the scene it moves away from, the unit it is about to
 * remove, the zone a capture belongs to. These predicates make those decisions in one place, which
 * is what keeps mounts, seeks, and repeated ticks landing on identical frames.
 */
import type { RenderOptions } from '@renderers/types.js'

import type { CraneReachScene, SceneEvent, SceneUnit } from './scene.js'
import { type EventShape, eventScale } from './timeline.js'

/** Something visibly reacts when a blow lands, a unit falls, or ground changes hands. */
export function eventHasReaction(event: SceneEvent): boolean {
  return (
    event.damage > 0 || event.deathId !== null || event.redCapture !== 0 || event.blueCapture !== 0
  )
}

/** What the schedule needs from an event: how far it travels, whether it strikes and provokes. */
export function eventShapeFor(event: SceneEvent): EventShape {
  return {
    movementTiles: event.movementTiles,
    hasTarget: event.targetId !== null,
    hasReaction: eventHasReaction(event),
  }
}

/** Retain the prior pure scene for as long as the transition is playing over it. */
export function transitionSceneFor(
  previousScene: CraneReachScene | null,
  finalScene: CraneReachScene,
  animate: boolean,
): CraneReachScene {
  return animate && previousScene !== null ? previousScene : finalScene
}

/** Transition eligibility keeps mount, seeks, and repeated ticks deterministic. */
export function shouldAnimateEvent(
  event: SceneEvent | null,
  freshForwardEvent: boolean,
  hasPriorScene: boolean,
  options: RenderOptions | undefined,
): boolean {
  return (
    event !== null &&
    freshForwardEvent &&
    hasPriorScene &&
    options?.snap !== true &&
    eventScale(options) > 0
  )
}

/** Recognize a new forward state while rejecting repeats and backward seeks. */
export function isFreshForwardEvent(
  previousTick: number | null,
  nextTick: number,
  previousEvent: SceneEvent | null,
  nextEvent: SceneEvent | null,
): boolean {
  if (previousTick === null || nextEvent === null) return false
  return nextTick > previousTick || (nextTick === previousTick && previousEvent === null)
}

/** A fresh nonsnap event waits for the in-flight or already-deferred event to paint its final frame. */
export function shouldDeferEventUpdate(
  eventIncomplete: boolean,
  freshForwardEvent: boolean,
  immediate: boolean,
  hasPendingUpdate: boolean,
): boolean {
  return !immediate && freshForwardEvent && (eventIncomplete || hasPendingUpdate)
}

/** Static terrain survives state changes and rebuilds only for a new battlefield identity. */
export function shouldRebuildBattlefield(
  previousKey: string | null,
  scene: CraneReachScene,
  battlefieldTextured: boolean,
  assetsReady: boolean,
): boolean {
  return previousKey !== scene.battlefieldKey || (assetsReady && !battlefieldTextured)
}

/** A fresh forward death borrows the defeated figure from the preceding pure frame. */
export function deathSnapshotFor(
  previousScene: CraneReachScene | null,
  scene: CraneReachScene,
): SceneUnit | null {
  const deathId = scene.event?.deathId
  if (deathId === null || deathId === undefined || previousScene === null) return null
  return previousScene.units.find((candidate) => candidate.unitId === deathId) ?? null
}

/** Resolve a target across the final scene and the retained death snapshot for every tween frame. */
export function eventTargetPositionFor(
  event: SceneEvent,
  currentScene: CraneReachScene | null,
  previousScene: CraneReachScene | null,
  deathSnapshot: SceneUnit | null,
): { x: number; y: number } | null {
  if (event.targetId === null) return null
  return (
    currentScene?.units.find((unit) => unit.unitId === event.targetId)?.position ??
    previousScene?.units.find((unit) => unit.unitId === event.targetId)?.position ??
    (deathSnapshot?.unitId === event.targetId ? deathSnapshot.position : null)
  )
}

export interface CaptureCue {
  side: 'red' | 'blue'
  delta: number
  position: { x: number; y: number }
}

/** Place each side's aggregate capture change on the zone it most clearly controls. */
export function captureCuesFor(scene: CraneReachScene, event: SceneEvent): CaptureCue[] {
  const cues = (['red', 'blue'] as const).flatMap((side) => {
    const delta = side === 'red' ? event.redCapture : event.blueCapture
    if (delta === 0) return []
    const ranked = scene.zones
      .map((zone) => {
        const tileKeys = new Set(zone.tileKeys)
        const balance = scene.units.reduce(
          (score, unit) =>
            tileKeys.has(unit.tileKey) ? score + (unit.side === side ? 1 : -1) : score,
          0,
        )
        return {
          zone,
          balance,
          distance: Math.hypot(zone.center.x - event.to.x, zone.center.y - event.to.y),
        }
      })
      .sort(
        (left, right) =>
          right.balance - left.balance ||
          left.distance - right.distance ||
          left.zone.key.localeCompare(right.zone.key),
      )
    const position = ranked[0]?.zone.center ?? event.to
    return [{ side, delta, position: { ...position } }]
  })
  if (
    cues.length === 2 &&
    cues[0] !== undefined &&
    cues[1] !== undefined &&
    cues[0].position.x === cues[1].position.x &&
    cues[0].position.y === cues[1].position.y
  ) {
    cues[0].position.x -= scene.hexRadius * 0.28
    cues[1].position.x += scene.hexRadius * 0.28
  }
  return cues
}

/** Capture ownership is a result of the completed action, so placement reads final occupancy. */
export function captureCueSceneFor(
  finalScene: CraneReachScene | null,
  presentedScene: CraneReachScene | null,
): CraneReachScene | null {
  return finalScene ?? presentedScene
}
