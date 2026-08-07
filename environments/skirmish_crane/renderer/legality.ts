/**
 * Crane Reach legality in the browser: the paths the acting unit may walk and the enemies it may
 * name, computed from the overlay alone.
 *
 * This is the one place the rules live twice, so it is written to mirror the engine's `walk` and
 * `_nameable_targets` step for step, and the mask-agreement suite proves the two agree exactly on
 * every recorded activation of both fixtures. Costs and passability are read from the same
 * `tile_types.json` the engine reads, so those cannot drift at all.
 *
 * The human composes a path against `continuations`, so only legal steps are ever offered; the full
 * enumeration exists for the agreement suite and for the movement-range wash.
 */
import tileTypes from '../tile_types.json'

import { encodePath, MAX_PATH_STEPS } from './paths.js'
import {
  type FeatureName,
  HEX_DIRECTIONS,
  type HexTile,
  type SceneRosterEntry,
  type SceneUnit,
  type TerrainName,
  tileCoordinate,
  UNIT_STATS,
} from './scene.js'

const TERRAINS: Record<TerrainName, { passable: boolean; move_cost: number }> = tileTypes.terrains
const FEATURES: Record<FeatureName, { move_cost_delta: number }> = tileTypes.features

function passable(tile: HexTile): boolean {
  return TERRAINS[tile.terrain].passable
}

function stepCost(tile: HexTile): number {
  return TERRAINS[tile.terrain].move_cost + FEATURES[tile.feature].move_cost_delta
}

/** The board as one activation sees it: the acting unit's own tile is not an obstacle to itself. */
export interface WalkField {
  tileAt: (tileKey: string) => HexTile | undefined
  occupied: ReadonlySet<string>
  movement: number
}

/** A walked path and what it has spent. */
export interface WalkPath {
  /** Direction digits taken so far, 1 through 6. */
  directions: number[]
  /** Tile keys entered, beginning with the unit's own tile. */
  tiles: string[]
  /** Movement points left. This goes negative only on an expensive first step, which then ends the path. */
  remaining: number
}

export function walkFieldFor(
  unit: Pick<SceneUnit, 'tileKey' | 'type' | 'unitId'>,
  tiles: readonly HexTile[],
  units: readonly Pick<SceneUnit, 'tileKey' | 'unitId'>[],
): WalkField {
  const byKey = new Map(tiles.map((tile) => [tile.key, tile]))
  return {
    tileAt: (tileKey) => byKey.get(tileKey),
    occupied: new Set(
      units.filter((other) => other.unitId !== unit.unitId).map((other) => other.tileKey),
    ),
    movement: UNIT_STATS[unit.type].movement,
  }
}

export function emptyWalk(
  unit: Pick<SceneUnit, 'tileKey'>,
  field: Pick<WalkField, 'movement'>,
): WalkPath {
  return { directions: [], tiles: [unit.tileKey], remaining: field.movement }
}

/**
 * The legal next steps from here, as direction digit to the tile it enters. Empty once the path has
 * spent its four steps or has gone into a negative balance, which the ruleset requires to end it.
 */
export function continuations(field: WalkField, path: WalkPath): Map<number, string> {
  const options = new Map<number, string>()
  if (path.directions.length >= MAX_PATH_STEPS || path.remaining < 0) return options
  const from = tileCoordinate(path.tiles[path.tiles.length - 1] as string)
  const firstStep = path.directions.length === 0
  for (let direction = 1; direction <= 6; direction += 1) {
    const [dq, dr] = HEX_DIRECTIONS[direction - 1] as readonly [number, number]
    const tileKey = `${from.q + dq},${from.r + dr}`
    const tile = field.tileAt(tileKey)
    if (tile === undefined || !passable(tile) || field.occupied.has(tileKey)) continue
    // At full movement points a unit may always take one step, whatever the ground costs.
    if (!firstStep && path.remaining < stepCost(tile)) continue
    options.set(direction, tileKey)
  }
  return options
}

/** Take one legal step. Anything the person can click came from `continuations`, so this cannot fail there. */
export function extend(field: WalkField, path: WalkPath, direction: number): WalkPath {
  const tileKey = continuations(field, path).get(direction)
  if (tileKey === undefined) throw new Error('Crane Reach cannot walk that step')
  return {
    directions: [...path.directions, direction],
    tiles: [...path.tiles, tileKey],
    remaining: path.remaining - stepCost(field.tileAt(tileKey) as HexTile),
  }
}

/** Every walkable path from the unit's tile, the empty stay path first. */
export function walkablePaths(field: WalkField, unit: Pick<SceneUnit, 'tileKey'>): WalkPath[] {
  const paths = [emptyWalk(unit, field)]
  let frontier = [...paths]
  while (frontier.length > 0) {
    const next: WalkPath[] = []
    for (const path of frontier) {
      for (const direction of continuations(field, path).keys()) {
        const extended = extend(field, path, direction)
        paths.push(extended)
        next.push(extended)
      }
    }
    frontier = next
  }
  return paths
}

/** The walkable paths as the ids the action space uses. */
export function walkablePathIds(field: WalkField, unit: Pick<SceneUnit, 'tileKey'>): Set<number> {
  return new Set(walkablePaths(field, unit).map((path) => encodePath(path.directions)))
}

/**
 * Every tile the unit could end on this activation, including the one it stands on, since the stay
 * path is always legal. This drives the movement-range wash.
 */
export function reachableTileKeys(
  unit: Pick<SceneUnit, 'tileKey' | 'type' | 'unitId'>,
  tiles: readonly HexTile[],
  units: readonly Pick<SceneUnit, 'tileKey' | 'unitId'>[],
): Set<string> {
  const field = walkFieldFor(unit, tiles, units)
  return new Set(
    walkablePaths(field, unit).map((path) => path.tiles[path.tiles.length - 1] as string),
  )
}

/**
 * The enemy roster in the order the target component names it: value i names slot i - 1, fixed at
 * construction from the initial roster, so a death never renumbers anything.
 */
export function enemyRoster(
  roster: readonly SceneRosterEntry[],
  side: SceneUnit['side'],
): SceneRosterEntry[] {
  return roster.filter((entry) => entry.side !== side)
}

/** The nameable targets as the values the action space uses, where 0 is always the legal none. */
export function nameableTargetValues(
  visible: ReadonlySet<string>,
  roster: readonly SceneRosterEntry[],
  side: SceneUnit['side'],
): Set<number> {
  const values = new Set([0])
  for (const [slot, entry] of enemyRoster(roster, side).entries()) {
    if (visible.has(entry.unitId)) values.add(slot + 1)
  }
  return values
}
