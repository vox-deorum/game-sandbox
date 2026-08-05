/** Reachable Crane Reach destinations for the draw-only movement-range display. */
import type { HexTile, SceneUnit } from './scene.js'

const DIRECTIONS = [
  [1, -1],
  [1, 0],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [0, -1],
] as const

const TERRAIN_COST = { grass: 1, hill: 2, water: 0, void: 0 } as const
const FEATURE_COST = { none: 0, forest: 1, marsh: 2, waste: 0 } as const

/** The HUD has no action affordance. It only mirrors the environment's walk rules for a range wash. */
export function reachableTileKeys(
  unit: Pick<SceneUnit, 'tileKey' | 'type' | 'unitId'>,
  tiles: readonly HexTile[],
  units: readonly Pick<SceneUnit, 'tileKey' | 'unitId'>[],
): Set<string> {
  const [startQ, startR] = unit.tileKey.split(',').map(Number)
  const byKey = new Map(tiles.map((tile) => [tile.key, tile]))
  const occupied = new Set(units.filter((other) => other.unitId !== unit.unitId).map((other) => other.tileKey))
  const movement = unit.type === 'footman' ? 2 : unit.type === 'archer' ? 2 : 4
  // Path id 0 is the stand-still order. Keeping the origin makes this destination set agree with
  // the fixture legality vector and lets the activation seal remain the visible marker for it.
  const reached = new Set<string>([unit.tileKey])
  const frontier = [{ q: startQ as number, r: startR as number, remaining: movement, steps: 0 }]
  const seen = new Set(frontier.map(({ q, r, remaining, steps }) => `${q},${r}:${remaining}:${steps}`))

  while (frontier.length > 0) {
    const current = frontier.shift()
    if (current === undefined || current.steps === 4) continue
    for (const [dq, dr] of DIRECTIONS) {
      const q = current.q + dq
      const r = current.r + dr
      const key = `${q},${r}`
      const tile = byKey.get(key)
      if (tile === undefined || tile.terrain === 'water' || tile.terrain === 'void' || occupied.has(key)) continue
      const cost = TERRAIN_COST[tile.terrain] + FEATURE_COST[tile.feature]
      if (current.steps > 0 && current.remaining < cost) continue
      const remaining = current.remaining - cost
      reached.add(key)
      if (remaining < 0) continue
      const next = { q, r, remaining, steps: current.steps + 1 }
      const signature = `${q},${r}:${remaining}:${next.steps}`
      if (!seen.has(signature)) {
        seen.add(signature)
        frontier.push(next)
      }
    }
  }
  return reached
}
