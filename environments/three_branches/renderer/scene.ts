import type { StepState } from '@game-sandbox/schema'
import { clamp, interpolateDegrees, lerp } from '@renderers/base/math.js'

import { CATALOG, RULES, readDynamic } from './overlay.js'
import { groundColor, PALETTE, THREE_BRANCHES_PRESENTATION } from './presentation.js'
import type { FrameScene, StaticScene, VillageStatic, WorldPoint, WorldRect } from './types.js'

const STRUCTURE_GROUND = new Set(['interior', 'doorway', 'wall'])

/** Convert configured metres to the renderer's provisional world scale. */
export function metresToWorld(value: number): number {
  return value * THREE_BRANCHES_PRESENTATION.unitsPerMetre
}

/** Convert a north-up recorded point into Pixi's downward-y world. */
export function pointToWorld(staticVillage: VillageStatic, x: number, y: number): WorldPoint {
  const heightMetres = staticVillage.size.cellsY * staticVillage.size.cellSize
  return { x: metresToWorld(x), y: metresToWorld(heightMetres - y) }
}

/** Convert a north-up recorded rectangle into its Pixi top-left rectangle. */
export function rectToWorld(
  staticVillage: VillageStatic,
  x: number,
  y: number,
  width: number,
  height: number,
): WorldRect {
  const point = pointToWorld(staticVillage, x, y + height)
  return { ...point, width: metresToWorld(width), height: metresToWorld(height) }
}

/** Build immutable display data from the recording header and shared configuration. */
export function buildStaticScene(village: VillageStatic): StaticScene {
  const ground = RULES.grounds.map((source) => ({
    code: source.code,
    name: source.name,
    color: groundColor(source.name),
    passable: source.passable,
    layer:
      source.code === RULES.fill
        ? ('base' as const)
        : STRUCTURE_GROUND.has(source.name)
          ? ('structure' as const)
          : ('landscape' as const),
  }))
  const groundByCode = Object.fromEntries(ground.map((item) => [item.code, item]))
  const buildingByType = Object.fromEntries(CATALOG.buildings.map((item) => [item.token, item]))
  const propByType = Object.fromEntries(CATALOG.props.map((item) => [item.token, item]))
  const sceneryByType = Object.fromEntries(CATALOG.scenery.map((item) => [item.token, item]))
  const buildings = village.buildings.map((item) => {
    const kind = buildingByType[item.type]
    if (kind === undefined) throw new Error(`Unknown building type ${item.type}.`)
    return {
      id: item.id,
      type: item.type,
      label: labelFor(item.type),
      shape: 'box' as const,
      rect: rectToWorld(
        village,
        item.cell.x * village.size.cellSize,
        item.cell.y * village.size.cellSize,
        kind.width * village.size.cellSize,
        kind.height * village.size.cellSize,
      ),
    }
  })
  const props = village.props.map((item) => {
    const kind = propByType[item.type]
    if (kind === undefined) throw new Error(`Unknown prop type ${item.type}.`)
    return {
      id: item.id,
      type: item.type,
      label: labelFor(kind.activity),
      shape: shapeOf(kind.shape),
      rect: rectToWorld(
        village,
        item.cell.x * village.size.cellSize,
        item.cell.y * village.size.cellSize,
        kind.width * village.size.cellSize,
        kind.height * village.size.cellSize,
      ),
      facing: item.facing,
    }
  })
  const scenery = village.scenery.map((item, index) => {
    const kind = sceneryByType[item.type]
    if (kind === undefined) throw new Error(`Unknown scenery type ${item.type}.`)
    return {
      id: `scenery:${index}`,
      type: item.type,
      label: labelFor(item.type),
      shape: shapeOf(kind.shape),
      rect: rectToWorld(
        village,
        item.cell.x * village.size.cellSize,
        item.cell.y * village.size.cellSize,
        kind.width * village.size.cellSize,
        kind.height * village.size.cellSize,
      ),
    }
  })
  return {
    village,
    world: {
      width: metresToWorld(village.size.cellsX * village.size.cellSize),
      height: metresToWorld(village.size.cellsY * village.size.cellSize),
    },
    spawn: pointToWorld(village, village.spawn.x, village.spawn.y),
    ground,
    groundByCode,
    // The header stays south-first. This is the sole inversion before the tiled drawing boundary.
    topFirstRows: [...village.ground].reverse(),
    buildings,
    props,
    scenery,
  }
}

/** Compute one deterministic drawable frame while retaining the mount-time static scene by reference. */
export function computeScene(
  state: StepState,
  staticScene: StaticScene,
  expectedIds: readonly string[],
): FrameScene {
  const dynamic = readDynamic(state, expectedIds, staticScene.village)
  const radius = metresToWorld(RULES.profile.body_radius)
  const characters = (dynamic?.characters ?? []).map((character) => ({
    ...character,
    point: pointToWorld(staticScene.village, character.x, character.y),
    radius,
    fill: character.id === 'visitor' ? PALETTE.visitor : PALETTE.npc,
    label:
      character.expression.type === 'none'
        ? character.id
        : `${character.id}: ${labelFor(character.expression.type)}`,
  }))
  return { static: staticScene, dynamic, characters }
}

/** Interpolate matching stable-id characters while keeping the target frame authoritative. */
export function interpolateScene(from: FrameScene, to: FrameScene, progress: number): FrameScene {
  const amount = clamp(progress, 0, 1)
  const prior = new Map(from.characters.map((character) => [character.id, character]))
  return {
    ...to,
    characters: to.characters.map((character) => {
      const start = prior.get(character.id)
      if (start === undefined) return character
      return {
        ...character,
        x: lerp(start.x, character.x, amount),
        y: lerp(start.y, character.y, amount),
        heading: interpolateDegrees(start.heading, character.heading, amount),
        point: {
          x: lerp(start.point.x, character.point.x, amount),
          y: lerp(start.point.y, character.point.y, amount),
        },
      }
    }),
  }
}

/** Convert a rules or catalog token into a compact diagnostic label. */
export function labelFor(token: string): string {
  return token.replaceAll('_', ' ')
}

function shapeOf(value: string): 'box' | 'circle' {
  if (value === 'box' || value === 'circle') return value
  throw new Error(`Unknown catalog shape ${value}.`)
}
