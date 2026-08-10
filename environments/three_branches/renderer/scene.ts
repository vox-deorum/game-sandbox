/** Pure, seek-safe drawables for the initial Three Branches village renderer. */
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

export interface Palette {
  ground: Record<string, string>
  buildingFill: string
  buildingOutline: string
  bridge: string
  scenery: string
  prop: string
  character: string
  collision: string
}

const groundColors = ['#a98262', '#8da970', '#aab764', '#6f9b7d', '#5d8da5']
const ground = Object.fromEntries(
  rulesData.ground.map((item, index) => [item.code, groundColors[index] ?? '#000000']),
)

/** The deliberately plain stage-three palette. Ground keys stay in rules.json code order. */
export const PALETTE: Palette = {
  ground,
  buildingFill: '#d8c19b',
  buildingOutline: '#624d3a',
  bridge: '#8b6a4d',
  scenery: '#537a4c',
  prop: '#b27746',
  character: '#3d536b',
  collision: '#e03e3e',
}

export interface WorldLine {
  width: number
  points: Point[]
}

export interface StaticScene {
  tileRows: string[]
  channels: WorldLine[]
  road: WorldLine
  footpaths: WorldLine[]
  bridges: Array<{ position: Point; heading: number; width: number; span: number }>
  buildings: Array<{
    id: string
    type: string
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

export interface DynamicScene {
  characters: Array<{
    id: string
    position: Point
    radius: number
    headingEnd: Point
    expression: string
    expressionLabel: string
    target: string
  }>
  props: Array<{ id: string; state: string; stateLabel: string }>
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
  const scene: StaticScene = {
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

function dynamicScene(state: DynamicOverlay): DynamicScene {
  return {
    characters: state.characters.map((character) => ({
      id: character.id,
      position: worldPoint(character.position),
      radius: worldLength(CHARACTER_RADIUS_METERS),
      headingEnd: worldPoint(headingEndpoint(character.position, character.heading)),
      expression: character.expression,
      expressionLabel: expressionLabel(character.expression, character.target),
      target: character.target,
    })),
    props: Object.entries(state.prop_states).map(([id, stateLabel]) => ({
      id,
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
