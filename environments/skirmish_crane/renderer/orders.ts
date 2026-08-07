/**
 * Composing one order on the board.
 *
 * The person builds a path a step at a time, and only legal continuations are ever offered, so the
 * composition is legal by construction and the confirmation button never has to validate anything.
 * There is deliberately no click-to-destination pathfinding: finding a route is the student's work in
 * this course, so a person walks it the same way their program has to.
 *
 * Human input always sends `target: 0` and previews the automatic strike instead of naming a victim.
 */
import { continuations, emptyWalk, extend, type WalkField, type WalkPath } from './legality.js'
import { encodePath } from './paths.js'
import { hexDistance, type SceneUnit, tileCoordinate, UNIT_STATS } from './scene.js'

/** Everything that decides whether a person is being asked for an order right now. */
export interface OrderTurn {
  /** The player the environment is waiting on, or null once the match is over. */
  actingPlayerId: string | null
  controlledPlayers: readonly string[]
  /** Whether this viewer has an action sender at all. A spectator and a replay viewer do not. */
  canSend: boolean
  terminal: boolean
  /** Whether the previous activation is still playing out on screen. */
  animating: boolean
  /** Whether this activation's order has already been sent. */
  sent: boolean
}

/**
 * Whether the order controls are live. Everything is closed by default: without a sender nothing on
 * the board is clickable at all, which is what makes a spectator and a replay viewer draw-only.
 */
export function orderTurnOpen(turn: OrderTurn): boolean {
  if (!turn.canSend || turn.terminal || turn.animating || turn.sent) return false
  return turn.actingPlayerId !== null && turn.controlledPlayers.includes(turn.actingPlayerId)
}

export interface OrderComposition {
  /** The activated unit this composition belongs to; a new activation starts a new composition. */
  unitId: string
  path: WalkPath
}

export function beginOrder(
  unit: Pick<SceneUnit, 'unitId' | 'tileKey'>,
  field: WalkField,
): OrderComposition {
  return { unitId: unit.unitId, path: emptyWalk(unit, field) }
}

/** The tile the unit would end on, which is where the automatic strike resolves from. */
export function endpointOf(order: OrderComposition): string {
  return order.path.tiles[order.path.tiles.length - 1] as string
}

/** The tiles a click may extend the path onto. Nothing else on the board is clickable. */
export function offeredTiles(field: WalkField, order: OrderComposition): Map<string, number> {
  const offered = new Map<string, number>()
  for (const [direction, tileKey] of continuations(field, order.path))
    offered.set(tileKey, direction)
  return offered
}

/**
 * Apply a board click. Clicking the activated unit clears the path, clicking the current endpoint
 * takes that step back, and clicking an offered tile appends it. Anything else leaves the order
 * alone, so a stray click on the battlefield can never compose something illegal.
 *
 * Clearing wins when a path has looped back onto the unit's own tile: the ruleset lets a unit walk
 * back where it started, but that tile is the reset control while an order is being composed.
 */
export function clickTile(
  field: WalkField,
  order: OrderComposition,
  tileKey: string,
): OrderComposition {
  const origin = order.path.tiles[0] as string
  if (tileKey === origin) {
    return order.path.directions.length === 0
      ? order
      : {
          unitId: order.unitId,
          path: { directions: [], tiles: [origin], remaining: field.movement },
        }
  }
  if (order.path.directions.length > 0 && tileKey === endpointOf(order))
    return undoStep(field, order)
  const direction = offeredTiles(field, order).get(tileKey)
  return direction === undefined
    ? order
    : { unitId: order.unitId, path: extend(field, order.path, direction) }
}

/** Take the last step back, replaying the shorter path so its movement balance stays exact. */
export function undoStep(field: WalkField, order: OrderComposition): OrderComposition {
  const kept = order.path.directions.slice(0, -1)
  const origin = order.path.tiles[0] as string
  let path: WalkPath = { directions: [], tiles: [origin], remaining: field.movement }
  for (const direction of kept) path = extend(field, path, direction)
  return { unitId: order.unitId, path }
}

/** The action this order sends. Human input never names a target, so the strike resolves automatically. */
export function orderAction(order: OrderComposition): { path: number; target: number } {
  return { path: encodePath(order.path.directions), target: 0 }
}

export interface StrikePreview {
  /** The nearest in-range enemies, which is what the automatic strike would draw from. */
  targets: string[]
  /** True when several tie for nearest, so which one is struck is a draw rather than a certainty. */
  uncertain: boolean
}

/**
 * The informational automatic-strike preview from a projected final tile: the unique nearest enemy in
 * range, every enemy tied for nearest, or nothing when none is in range. It reads only the enemies the
 * person can see, so it never reveals a unit the fog is hiding and may therefore be wrong about an
 * unseen one. It sends nothing and never advances the match.
 */
export function strikePreview(
  unit: Pick<SceneUnit, 'type' | 'side'>,
  endpoint: string,
  visibleEnemies: readonly Pick<SceneUnit, 'unitId' | 'side' | 'tileKey'>[],
): StrikePreview | null {
  const from = tileCoordinate(endpoint)
  const range = UNIT_STATS[unit.type].range
  let nearest = Number.POSITIVE_INFINITY
  let targets: string[] = []
  for (const enemy of visibleEnemies) {
    if (enemy.side === unit.side) continue
    const distance = hexDistance(from, tileCoordinate(enemy.tileKey))
    if (distance > range) continue
    if (distance < nearest) {
      nearest = distance
      targets = [enemy.unitId]
    } else if (distance === nearest) {
      targets.push(enemy.unitId)
    }
  }
  return targets.length === 0 ? null : { targets, uncertain: targets.length > 1 }
}
