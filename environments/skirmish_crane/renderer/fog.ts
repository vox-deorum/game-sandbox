/**
 * The perspective rule for a person playing under fog.
 *
 * A viewer who controls nobody, and any finished match, sees the whole board. Otherwise the board is
 * drawn from one perspective: the acting unit's own vision whenever the unit acting belongs to the
 * human's seat, whether the person or a companion is deciding for it, and the union of that seat's
 * living units on an opponent's turn. Terrain is never hidden, because the generated battlefield is
 * standing knowledge in the ruleset; the veil only says where perception ends, and units outside it
 * are simply not drawn.
 */
import type { RecordingHeader } from '@game-sandbox/schema'

import {
  type CraneReachScene,
  hexDistance,
  type SceneUnit,
  tileCoordinate,
  UNIT_STATS,
} from './scene.js'

export interface Perspective {
  /** The players whose vision this frame is drawn from. */
  observers: string[]
  /** The unit ids drawn this frame. */
  units: Set<string>
  /** The tile keys inside the perspective's vision. Everything else takes the mist veil. */
  tiles: Set<string>
}

/** A unit sees one tile further from high ground, which is the only modifier vision has. */
export function visionRadius(unit: SceneUnit, scene: CraneReachScene): number {
  const tile = scene.tiles.find((candidate) => candidate.key === unit.tileKey)
  return UNIT_STATS[unit.type].vision + (tile?.terrain === 'hill' ? 1 : 0)
}

/** The seat the controlled players sit in, which is the side a human plays. */
function seatMembers(
  controlled: readonly string[],
  seats: RecordingHeader['seats'] | undefined,
): string[] {
  for (const members of Object.values(seats ?? {})) {
    if (members.some((player) => controlled.includes(player))) return [...members]
  }
  return [...controlled]
}

/**
 * The perspective this frame is drawn from, or null when nothing is hidden. Null is the spectator,
 * the replay viewer, and every terminal frame.
 */
export function perspectiveFor(
  scene: CraneReachScene,
  controlled: readonly string[],
  seats: RecordingHeader['seats'] | undefined,
): Perspective | null {
  if (controlled.length === 0 || scene.hud.terminal !== null) return null
  const living = new Map(scene.units.map((unit) => [unit.playerId, unit]))
  const side = seatMembers(controlled, seats)
  const acting = scene.activation
  const observers =
    acting !== null && side.includes(acting.playerId)
      ? [acting.playerId]
      : side.filter((player) => living.has(player))

  return perspectiveForObservers(scene, observers)
}

/**
 * Rebuild a view from known observers against a particular scene. Event presentation uses this when
 * a moving unit reaches its final tile: the same observers see from their new positions before a
 * strike or capture reaction begins.
 */
export function perspectiveForObservers(
  scene: CraneReachScene,
  observers: readonly string[],
  retainedUnitId: string | null = null,
): Perspective | null {
  if (scene.hud.terminal !== null) return null
  const living = new Map(scene.units.map((unit) => [unit.playerId, unit]))
  const livingObservers = observers.filter((player) => living.has(player))

  const units = new Set<string>()
  const tiles = new Set<string>()
  for (const player of livingObservers) {
    const observer = living.get(player)
    if (observer === undefined) continue
    units.add(observer.unitId)
    for (const seen of scene.visibility.get(player) ?? []) units.add(seen)
    const from = tileCoordinate(observer.tileKey)
    const radius = visionRadius(observer, scene)
    for (const tile of scene.tiles) {
      if (hexDistance(from, tile) <= radius) tiles.add(tile.key)
    }
  }
  // A killed target has no final visibility record, but its retained prior node still needs to be
  // present for this event's death dissolve. Never retain a living target that the final masks hide.
  if (retainedUnitId !== null && !scene.units.some((unit) => unit.unitId === retainedUnitId)) {
    units.add(retainedUnitId)
  }
  return { observers: livingObservers, units, tiles }
}

/**
 * Whether a resolved activation should play out for this viewer.
 *
 * The event runs over the frame that preceded it, so it is that frame's perspective that decides. A
 * unit's own move is therefore always its own to watch, and the fog only follows whoever acts next
 * once the move has finished; judging by the arriving frame instead would skip a move whenever the
 * next unit to act happens not to see it.
 */
export function eventVisible(perspective: Perspective | null, actorId: string | null): boolean {
  if (actorId === null) return true
  return perspective === null || perspective.units.has(actorId)
}

/** The units a frame draws, which is everything unless a perspective hides some of it. */
export function visibleUnits(scene: CraneReachScene, perspective: Perspective | null): SceneUnit[] {
  if (perspective === null) return scene.units
  return scene.units.filter((unit) => perspective.units.has(unit.unitId))
}
