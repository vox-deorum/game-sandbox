import type { StepState } from '@game-sandbox/schema'
import { clamp, interpolateDegrees, lerp } from '@renderers/base/math.js'
import {
  groundColor,
  HEARTHSIDE_STYLE,
  PALETTE,
  THREE_BRANCHES_PRESENTATION,
} from '../core/presentation.js'
import type {
  Cell,
  CharacterExpression,
  FrameScene,
  StaticDrawable,
  StaticScene,
  VillageStatic,
  WorldPoint,
  WorldRect,
} from '../core/types.js'
import { CATALOG, RULES, readDynamic } from '../ui/overlay.js'

const STRUCTURE_GROUND = new Set(['interior', 'doorway', 'wall'])

const VISITOR_PLAYER = 'player_0'

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
  const buildings = village.buildings.map((item) =>
    drawableFor(village, buildingByType, item, () => ({
      label: labelFor(item.type),
      shape: 'box',
      collisionScale: 1,
    })),
  )
  const props = village.props.map((item) =>
    drawableFor(village, propByType, item, (kind) => ({
      label: labelFor(kind.activity),
      shape: shapeOf(kind.shape),
      collisionScale: kind.collision_scale,
    })),
  )
  const scenery = village.scenery.map((item, index) =>
    drawableFor(village, sceneryByType, { ...item, id: `scenery:${index}` }, (kind) => ({
      label: labelFor(item.type),
      shape: shapeOf(kind.shape),
      // The collisionScale carries the placement's collision factor; the engine scales a circular
      // scenery solid by it, and the sprite layers its own per-type visual scale on top, so the
      // debug overlay still draws the circle the engine collides with while art may look larger.
      collisionScale: item.scale,
    })),
  )
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
    fill: character.id === VISITOR_PLAYER ? PALETTE.visitor : PALETTE.npc,
    label:
      character.expression.type === 'none'
        ? character.id
        : `${character.id}: ${labelFor(character.expression.type)}`,
    // Sub-threshold drift neither animates feet nor returns the camera, so the recorded magnitude
    // zeroes out below the walk dead zone and the renderer stamps the cumulative distance later.
    moved: character.moved < HEARTHSIDE_STYLE.characters.walk.deadZone ? 0 : character.moved,
    walkDistance: 0,
    expressionTitle: expressionTitleFor(staticScene, character.expression),
  }))
  return { static: staticScene, dynamic, presentationTick: dynamic?.tick ?? 0, characters }
}

/**
 * Resolve one recorded expression into the chip's title text, or null for none.
 *
 * An emote carries its own token. A `use` expression names a prop instead, so its chip reads the
 * target prop's catalog activity, falling back to "Use" when the target is absent from the scene.
 */
export function expressionTitleFor(
  scene: StaticScene,
  expression: CharacterExpression,
): string | null {
  if (expression.type === 'none') return null
  if (expression.type !== 'use') return titleFor(expression.type)
  const target = scene.props.find((prop) => prop.id === expression.target)
  const kind =
    target === undefined ? undefined : CATALOG.props.find((item) => item.token === target.type)
  return titleFor(kind?.activity ?? 'use')
}

/**
 * Interpolate matching stable-id characters while keeping the target frame authoritative.
 *
 * During interpolation the walk flag is driven by the on-screen positional displacement rather than
 * the landed flag, so feet align with the moving sprite and rest when a wall zeroes the displacement.
 */
export function interpolateScene(from: FrameScene, to: FrameScene, progress: number): FrameScene {
  const amount = clamp(progress, 0, 1)
  const prior = new Map(from.characters.map((character) => [character.id, character]))
  return {
    ...to,
    presentationTick: lerp(from.presentationTick, to.presentationTick, amount),
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
        moved:
          start.point.x === character.point.x && start.point.y === character.point.y
            ? 0
            : character.moved,
        walkDistance: lerp(start.walkDistance, character.walkDistance, amount),
      }
    }),
  }
}

/**
 * Whether any matching character displaced at least the dead zone in recorded metres or turned
 * between two landed frames. Keyed on the position delta rather than the engine's reported
 * distance, so slow ground and wall slides that displace at or above the dead zone still glide,
 * while sub-dead-zone drift stays still.
 */
export function sceneCharactersMoved(from: FrameScene, to: FrameScene): boolean {
  const deadZone = HEARTHSIDE_STYLE.characters.walk.deadZone
  const prior = new Map(from.characters.map((character) => [character.id, character]))
  return to.characters.some((character) => {
    const start = prior.get(character.id)
    return (
      start !== undefined &&
      (Math.hypot(character.x - start.x, character.y - start.y) >= deadZone ||
        start.heading !== character.heading)
    )
  })
}

/**
 * Whether the visitor itself displaced at least the dead zone in recorded metres between two
 * frames, so sub-threshold drift neither returns the camera nor reads as motion.
 */
export function sceneVisitorMoved(from: FrameScene, to: FrameScene): boolean {
  const deadZone = HEARTHSIDE_STYLE.characters.walk.deadZone
  const start = from.characters.find((character) => character.id === VISITOR_PLAYER)
  const end = to.characters.find((character) => character.id === VISITOR_PLAYER)
  return (
    start !== undefined &&
    end !== undefined &&
    Math.hypot(end.x - start.x, end.y - start.y) >= deadZone
  )
}

/**
 * Next scene carrying the per-character walked-distance phase. A reset (replay seek) starts the
 * phase over; a held frame (snap or same-tick re-delivery) keeps the current phase; a landed frame
 * adds the dead-zoned per-tick distance. Returns a fresh scene, leaving the input untouched.
 */
export function advanceWalkDistance(
  accumulated: Map<string, number>,
  scene: FrameScene,
  mode: 'reset' | 'hold' | 'advance',
): FrameScene {
  if (mode === 'reset') accumulated.clear()
  const advance = mode === 'advance'
  return {
    ...scene,
    characters: scene.characters.map((character) => {
      if (!advance) {
        return { ...character, walkDistance: accumulated.get(character.id) ?? 0 }
      }
      const next = (accumulated.get(character.id) ?? 0) + character.moved
      accumulated.set(character.id, next)
      return { ...character, walkDistance: next }
    }),
  }
}

/**
 * Whether an in-flight movement should keep gliding toward the new frame instead of snapping to it:
 * true for a later landed frame, false for a same-tick re-presentation that is already its target.
 */
export function settleGlideOnto(movement: { to: FrameScene } | null, scene: FrameScene): boolean {
  return movement !== null && movement.to.dynamic?.tick !== scene.dynamic?.tick
}

/** What the transport should do with any in-flight movement for a freshly delivered frame. */
export type MovementAction = 'hold' | 'start' | 'settle' | 'snap'

/** A glide currently in flight, with the wall-clock progress to preserve when re-aimed. */
export interface MovementGlide {
  /** The landed frame the glide is heading to. */
  to: FrameScene
  /** Wall-clock time already spent gliding. */
  elapsedMs: number
  /** The wall-clock duration the glide was sized for. */
  durationMs: number
}

/** The inputs the renderer needs to choose one {@link MovementAction}. */
export interface MovementActionInput {
  /** Whether this delivery re-presents the current recorded tick on a connect (never a snap). */
  reDelivery: boolean
  /** Whether a new glide is warranted: a real landed movement or a sustained prop transition. */
  shouldAnimate: boolean
  /** Whether a scene is already on screen to glide from. */
  presentedScene: FrameScene | null
  /** Whether the delivery is a snap or same-tick re-presentation. */
  snapLike: boolean
  /** The glide currently in flight, or null. */
  movement: MovementGlide | null
  /** The freshly computed landed frame. */
  scene: FrameScene
}

/**
 * Decide how a delivered frame treats any in-flight movement. A same-tick re-delivery holds the
 * glide; real movement starts a new glide; a real stop settles the glide onto its frame while it
 * still has time left (a glide that already ran out across a skipped tick snaps instead of
 * lurching); and any snap, seek, or already-settled frame releases the glide. Re-aiming is never
 * applied to a snap or seek; those always snap to the landed frame.
 */
export function movementAction(input: MovementActionInput): MovementAction {
  if (input.reDelivery) return 'hold'
  if (input.shouldAnimate && input.presentedScene !== null) return 'start'
  if (
    !input.snapLike &&
    input.movement !== null &&
    input.movement.elapsedMs < input.movement.durationMs &&
    settleGlideOnto(input.movement, input.scene)
  ) {
    return 'settle'
  }
  return 'snap'
}

/** Convert a rules or catalog token into a compact diagnostic label. */
export function labelFor(token: string): string {
  return token.replaceAll('_', ' ')
}

/** Convert a rules token into a title-cased interface label. */
export function titleFor(token: string): string {
  return labelFor(token)
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function shapeOf(value: string): 'box' | 'circle' {
  if (value === 'box' || value === 'circle') return value
  throw new Error(`Unknown catalog shape ${value}.`)
}

interface CatalogFootprint {
  width: number
  height: number
}

interface DrawablePlacement {
  id: string
  type: string
  cell: Cell
  facing?: string
}

function drawableFor<TKind extends CatalogFootprint>(
  village: VillageStatic,
  catalog: Readonly<Record<string, TKind>>,
  placement: DrawablePlacement,
  describe: (kind: TKind) => Pick<StaticDrawable, 'label' | 'shape' | 'collisionScale'>,
): StaticDrawable {
  const kind = catalog[placement.type]
  if (kind === undefined) throw new Error(`Unknown catalog type ${placement.type}.`)
  // A placement facing east or west carries its catalog rectangle a quarter turn, as the engine does.
  const turned = placement.facing === 'east' || placement.facing === 'west'
  return {
    id: placement.id,
    type: placement.type,
    ...describe(kind),
    rect: rectToWorld(
      village,
      placement.cell.x * village.size.cellSize,
      placement.cell.y * village.size.cellSize,
      (turned ? kind.height : kind.width) * village.size.cellSize,
      (turned ? kind.width : kind.height) * village.size.cellSize,
    ),
    facing: placement.facing,
  }
}
