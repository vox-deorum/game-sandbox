/** Pure, seek-safe drawables for the initial Three Branches village renderer. */
import { stableHash } from '@renderers/base/math.js'

import propsData from '../props.json'
import rulesData from '../rules.json'
import {
  buildingWallSegments,
  CHARACTER_RADIUS_METERS,
  footprintCorners,
  headingEndpoint,
  worldLength,
  worldPoint,
} from './geometry.js'
import type { DynamicOverlay, Point, StaticOverlay } from './overlay.js'
import { HEARTHSIDE_STYLE, type HearthsideStyle, PRESENTATION } from './presentation.js'

export interface Palette extends HearthsideStyle {
  ground: Record<string, string>
  collision: string
}

const ground = Object.fromEntries(
  rulesData.ground.map((item) => {
    const colorName = PRESENTATION.ground.colors[item.code]
    if (colorName === undefined)
      throw new Error(`no presentation color for ground code ${item.code}`)
    return [item.code, HEARTHSIDE_STYLE[colorName]]
  }),
)

/** Hearthside Ink plus the derived ground-code and collision contracts. */
export const PALETTE: Palette = {
  ...HEARTHSIDE_STYLE,
  ground,
  collision: HEARTHSIDE_STYLE.cinnabar,
}

export interface WorldLine {
  width: number
  points: Point[]
}

export interface StaticScene {
  layoutKey: string
  tileRows: string[]
  channels: WorldLine[]
  road: WorldLine
  footpaths: WorldLine[]
  bridges: Array<{ position: Point; heading: number; width: number; span: number }>
  buildings: Array<{
    id: string
    type: string
    center: Point
    width: number
    depth: number
    rotation: number
    doorway: { position: Point; width: number }
    corners: Point[]
    walls: Array<{ start: Point; end: Point }>
  }>
  props: Array<{
    id: string
    type: string
    title: string
    position: Point
    rotation: number
    width: number
    depth: number
    corners: Point[]
  }>
  scenery: Array<{ id: string; type: string; position: Point; radius: number }>
  spawn: Point
}

export interface SceneCharacter {
  id: string
  position: Point
  radius: number
  heading: number
  moved: number
  headingEnd: Point
  expression: string
  expressionLabel: string
  target: string
}

/** The only part of a scene that differs between two decoded ticks, so the only per-frame work. */
export interface MotionScene {
  tick: number
  characters: SceneCharacter[]
}

export interface DynamicScene extends MotionScene {
  phase: string
  props: Array<{ id: string; type: string; state: string; stateLabel: string }>
  chrome: { tick: string; phase: string; bell: string; terminal: string | null }
}

export interface Scene {
  palette: Palette
  static: StaticScene
  dynamic: DynamicScene
}

const staticScenes = new WeakMap<StaticOverlay, StaticScene>()
const propsByToken = new Map(propsData.props.map((prop) => [prop.token, prop]))
const codesByToken = new Map(rulesData.ground.map((item) => [item.token, item.code]))

/** Compute a renderer-ready scene while retaining static drawables for this header reference. */
export function computeScene(state: DynamicOverlay, staticOverlay: StaticOverlay): Scene {
  return { palette: PALETTE, static: staticScene(staticOverlay), dynamic: dynamicScene(state) }
}

export function staticScene(staticOverlay: StaticOverlay): StaticScene {
  const cached = staticScenes.get(staticOverlay)
  if (cached) return cached
  const village = staticOverlay.village
  const layoutKey = layoutKeyFor(staticOverlay)
  const scene: StaticScene = {
    layoutKey,
    tileRows: village.ground.map((row) => row.map(groundCode).join('')),
    channels: village.channels.map(worldLine),
    road: worldLine(village.road),
    footpaths: village.footpaths.map(worldLine),
    bridges: village.bridges.map((bridge) => ({
      position: worldPoint(bridge.position),
      heading: bridge.heading,
      width: worldLength(bridge.width),
      span: worldLength(bridge.span),
    })),
    buildings: village.buildings.map((building) => ({
      id: building.id,
      type: building.type,
      center: worldPoint(building.center),
      width: worldLength(building.width),
      depth: worldLength(building.depth),
      rotation: building.rotation,
      doorway: {
        position: worldPoint(building.doorway.position),
        width: worldLength(building.doorway.width),
      },
      corners: footprintCorners(
        building.center,
        building.width,
        building.depth,
        building.rotation,
      ).map(worldPoint),
      walls: buildingWallSegments(building).map((wall) => ({
        start: worldPoint(wall.start),
        end: worldPoint(wall.end),
      })),
    })),
    props: village.props.map((prop) => {
      const definition = propsByToken.get(prop.type)
      if (!definition) throw new Error(`unknown prop type ${prop.type}`)
      return {
        id: prop.id,
        type: prop.type,
        title: definition.title,
        position: worldPoint(prop.position),
        rotation: prop.rotation,
        width: worldLength(definition.footprint.width),
        depth: worldLength(definition.footprint.depth),
        corners: footprintCorners(
          prop.position,
          definition.footprint.width,
          definition.footprint.depth,
          prop.rotation,
        ).map(worldPoint),
      }
    }),
    scenery: village.scenery.map((item, index) => ({
      id: `${item.type}_${index}`,
      type: item.type,
      position: worldPoint(item.position),
      radius: worldLength(item.radius),
    })),
    spawn: worldPoint(village.spawn),
  }
  staticScenes.set(staticOverlay, scene)
  return scene
}

/** Hash every decoded static-layout field that can affect deterministic dressing or ground art. */
export function layoutKeyFor(staticOverlay: StaticOverlay): string {
  return String(stableHash(JSON.stringify(staticOverlay.village)))
}

/** Place the cast for one frame, skipping the state treatment a decoded tick already resolved. */
export function motionScene(state: DynamicOverlay): MotionScene {
  return {
    tick: state.tick,
    characters: state.characters.map((character) => ({
      id: character.id,
      position: worldPoint(character.position),
      radius: worldLength(CHARACTER_RADIUS_METERS),
      heading: character.heading,
      moved: character.moved,
      headingEnd: worldPoint(headingEndpoint(character.position, character.heading)),
      expression: character.expression,
      expressionLabel: expressionLabel(character.expression, character.target),
      target: character.target,
    })),
  }
}

function dynamicScene(state: DynamicOverlay): DynamicScene {
  return {
    ...motionScene(state),
    phase: state.phase,
    props: Object.entries(state.prop_states).map(([id, stateLabel]) => ({
      id,
      type: id.slice(0, id.lastIndexOf('_')),
      state: stateLabel,
      stateLabel,
    })),
    chrome: {
      tick: `Tick ${state.tick} / ${rulesData.day_ticks}`,
      phase: `Phase: ${state.phase}`,
      bell: state.bell ? 'Bell: ringing' : 'Bell: silent',
      terminal: state.terminal ? 'The day is complete' : null,
    },
  }
}

function groundCode(token: string): string {
  const code = codesByToken.get(token)
  if (code === undefined) throw new Error(`unknown ground token ${token}`)
  return code
}

function worldLine(line: { width: number; points: Point[] }): WorldLine {
  return { width: worldLength(line.width), points: line.points.map(worldPoint) }
}

function expressionLabel(expression: string, target: string): string {
  if (expression === 'use') return `using ${propTitle(target)}`
  if (expression === 'none') return 'none'
  return expression
}

function propTitle(id: string): string {
  const token = id.slice(0, id.lastIndexOf('_'))
  return propsByToken.get(token)?.title ?? id
}
