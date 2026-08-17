/**
 * The renderer's mirror of the environment's use-selection rule, for the informational preview.
 *
 * The engine's `prop_use.select` picks the nearest interactive prop whose nearest collision-shape
 * point is within reach and joined by a line no wall cell crosses, breaking ties by canonical prop
 * order. This module reproduces that in renderer world units from the same collision shapes the
 * diagnostic overlay draws. The mirrored constants come from rules.json: `profile.prop_reach` is
 * the reach in metres and `grounds[].blocks_sight` marks the wall code as the only sight blocker.
 */

import type { CollisionShape, StaticScene, WorldPoint } from '../core/types.js'
import { metresToWorld } from '../map/scene.js'
import { RULES } from './overlay.js'

/** Reach in renderer units, mirrored from rules.json profile.prop_reach. */
const PROP_REACH_WORLD = metresToWorld(RULES.profile.prop_reach)

/** Ground codes that block sight, mirrored from rules.json grounds[].blocks_sight. */
const BLOCKS_SIGHT: ReadonlySet<string> = new Set(
  RULES.grounds.filter((ground) => ground.blocks_sight).map((ground) => ground.code),
)

/** Keep only the interactive-prop shapes, in the canonical prop order the tie break uses. */
export function propUseShapes(
  scene: StaticScene,
  shapes: readonly CollisionShape[],
): readonly CollisionShape[] {
  const propIds = new Set(scene.props.map((prop) => prop.id))
  return shapes.filter((shape) => propIds.has(shape.id))
}

/**
 * The prop id a use action would select from this position, or null when none qualifies.
 *
 * Iterating in canonical order with a strict distance comparison keeps the earlier prop on ties,
 * exactly as the engine's `min` over (distance, index) does.
 */
export function selectUseTarget(
  scene: StaticScene,
  propShapes: readonly CollisionShape[],
  from: WorldPoint,
): string | null {
  let best: { distance: number; id: string } | null = null
  for (const shape of propShapes) {
    const nearest = nearestPointOn(shape, from)
    const distance = Math.hypot(from.x - nearest.x, from.y - nearest.y)
    if (distance > PROP_REACH_WORLD) continue
    if (!lineClear(scene, from, nearest)) continue
    if (best === null || distance < best.distance) best = { distance, id: shape.id }
  }
  return best?.id ?? null
}

/** The closest point on a collision shape, mirroring the engine's nearest-point geometry. */
export function nearestPointOn(shape: CollisionShape, point: WorldPoint): WorldPoint {
  if (shape.kind === 'rect') {
    return {
      x: Math.min(Math.max(point.x, shape.rect.x), shape.rect.x + shape.rect.width),
      y: Math.min(Math.max(point.y, shape.rect.y), shape.rect.y + shape.rect.height),
    }
  }
  const dx = point.x - shape.center.x
  const dy = point.y - shape.center.y
  const length = Math.hypot(dx, dy)
  // A point exactly at the center projects east, as the engine's nearest_point_circle does.
  if (length === 0) return { x: shape.center.x + shape.radius, y: shape.center.y }
  return {
    x: shape.center.x + (shape.radius * dx) / length,
    y: shape.center.y + (shape.radius * dy) / length,
  }
}

/**
 * Whether no sight-blocking cell lies on the segment, walking the ground grid the way the
 * engine's supercover does, including both endpoint cells and the pair of side cells a corner
 * crossing touches, so the preview cannot see through a diagonal wall corner.
 */
export function lineClear(scene: StaticScene, start: WorldPoint, end: WorldPoint): boolean {
  const cellWorld = metresToWorld(scene.village.size.cellSize)
  const x0 = start.x / cellWorld
  const y0 = start.y / cellWorld
  const x1 = end.x / cellWorld
  const y1 = end.y / cellWorld
  let cellX = Math.floor(x0)
  let cellY = Math.floor(y0)
  const targetX = Math.floor(x1)
  const targetY = Math.floor(y1)
  // The engine's supercover answers an out-of-grid endpoint with no cells, which reads clear.
  if (!inBounds(scene, cellX, cellY) || !inBounds(scene, targetX, targetY)) return true
  if (blocksSight(scene, cellX, cellY)) return false
  if (cellX === targetX && cellY === targetY) return true
  const dx = x1 - x0
  const dy = y1 - y0
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Number.POSITIVE_INFINITY
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Number.POSITIVE_INFINITY
  let tMaxX = dx !== 0 ? (cellX + (stepX > 0 ? 1 : 0) - x0) / dx : Number.POSITIVE_INFINITY
  let tMaxY = dy !== 0 ? (cellY + (stepY > 0 ? 1 : 0) - y0) / dy : Number.POSITIVE_INFINITY
  // Each crossing advances a coordinate, so this bound turns a floating-point edge case into a
  // visible failure instead of a hung preview, matching the engine's guard.
  const limit = 2 * (Math.abs(targetX - cellX) + Math.abs(targetY - cellY) + 1)
  for (let step = 0; step < limit; step++) {
    if (cellX === targetX && cellY === targetY) return true
    // An endpoint on a cell edge belongs to the positive-side cell. Stop at t=1 rather than
    // crossing past that endpoint.
    if (Math.min(tMaxX, tMaxY) >= 1 - 1e-12) return !blocksSight(scene, targetX, targetY)
    if (Math.abs(tMaxX - tMaxY) < 1e-12) {
      // A corner touches both adjacent squares; either can block, and either can be the target.
      let reachedTarget = false
      for (const [sideX, sideY] of [
        [cellX + stepX, cellY],
        [cellX, cellY + stepY],
      ] as const) {
        if (inBounds(scene, sideX, sideY) && blocksSight(scene, sideX, sideY)) return false
        if (sideX === targetX && sideY === targetY) reachedTarget = true
      }
      if (reachedTarget) return true
      cellX += stepX
      cellY += stepY
      tMaxX += tDeltaX
      tMaxY += tDeltaY
    } else if (tMaxX < tMaxY) {
      cellX += stepX
      tMaxX += tDeltaX
    } else {
      cellY += stepY
      tMaxY += tDeltaY
    }
    if (blocksSight(scene, cellX, cellY)) return false
    if (cellX === targetX && cellY === targetY) return true
  }
  throw new Error('Three Branches use preview could not finish its line walk.')
}

function inBounds(scene: StaticScene, cellX: number, cellY: number): boolean {
  return (
    cellX >= 0 &&
    cellX < scene.village.size.cellsX &&
    cellY >= 0 &&
    cellY < scene.village.size.cellsY
  )
}

/** Read a top-first grid cell, since renderer world y runs downward from the north edge. */
function blocksSight(scene: StaticScene, cellX: number, cellY: number): boolean {
  const code = scene.topFirstRows[cellY]?.[cellX]
  return code !== undefined && BLOCKS_SIGHT.has(code)
}
