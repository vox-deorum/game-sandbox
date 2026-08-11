/** Collision-truth drawables. This module deliberately shares no art decisions. */
import propsData from '../props.json'
import {
  buildingWallSegments,
  CHARACTER_RADIUS_METERS,
  footprintCorners,
  headingEndpoint,
  STATIC_SEGMENT_RADIUS_METERS,
  waterBankSegments,
  waterConfluenceDisks,
  worldBoundarySegments,
  worldLength,
  worldPoint,
} from './geometry.js'
import type { DynamicOverlay, Point, StaticOverlay } from './overlay.js'

interface CollisionSegment {
  id: string
  start: Point
  end: Point
  radius: number
  label: string
}

interface CollisionCircle {
  id: string
  center: Point
  radius: number
  label: string
}

/** Geometry pinned by the recording header and mounted once for the renderer lifetime. */
export interface StaticCollisionScene {
  buildings: Array<{
    id: string
    label: string
    walls: Array<{ start: Point; end: Point; radius: number }>
  }>
  waterBanks: CollisionSegment[]
  confluences: CollisionCircle[]
  boundaries: CollisionSegment[]
  props: Array<{ id: string; corners: Point[] }>
  scenery: CollisionCircle[]
}

/** Collision labels and bodies that can change from one decoded tick to the next. */
export interface DynamicCollisionScene {
  propLabels: Array<{ id: string; label: string }>
  characterLabels: Array<{ id: string; label: string }>
  characters: CollisionBody[]
}

/** A moving body: exactly what an in-between frame needs to place one, and nothing else. */
export interface CollisionBody {
  id: string
  position: Point
  radius: number
  headingEnd: Point
}

const propsByToken = new Map(propsData.props.map((prop) => [prop.token, prop]))

/** Compute immutable collision geometry once from the recording header. */
export function computeStaticCollisionScene(staticOverlay: StaticOverlay): StaticCollisionScene {
  return {
    buildings: staticOverlay.village.buildings.map((building) => ({
      id: building.id,
      label: building.id,
      walls: buildingWallSegments(building).map((wall) => ({
        start: worldPoint(wall.start),
        end: worldPoint(wall.end),
        radius: worldLength(STATIC_SEGMENT_RADIUS_METERS),
      })),
    })),
    waterBanks: waterBankSegments(staticOverlay.village).map((segment, index) => ({
      id: `water_bank_${index}`,
      start: worldPoint(segment.start),
      end: worldPoint(segment.end),
      radius: worldLength(STATIC_SEGMENT_RADIUS_METERS),
      label: `Water bank ${index + 1}`,
    })),
    confluences: waterConfluenceDisks(staticOverlay.village).map((disk, index) => ({
      id: `water_confluence_${index}`,
      center: worldPoint(disk.center),
      radius: worldLength(disk.radius),
      label: `Water confluence ${index + 1}`,
    })),
    boundaries: worldBoundarySegments().map((segment, index) => ({
      id: `world_boundary_${index}`,
      start: worldPoint(segment.start),
      end: worldPoint(segment.end),
      radius: worldLength(STATIC_SEGMENT_RADIUS_METERS),
      label: `World boundary ${index + 1}`,
    })),
    props: staticOverlay.village.props.map((prop) => {
      const definition = propsByToken.get(prop.type)
      if (definition === undefined) throw new Error(`unknown prop type ${prop.type}`)
      return {
        id: prop.id,
        corners: footprintCorners(
          prop.position,
          definition.footprint.width,
          definition.footprint.depth,
          prop.rotation,
        ).map(worldPoint),
      }
    }),
    scenery: staticOverlay.village.scenery.map((item, index) => ({
      id: `${item.type}_${index}`,
      center: worldPoint(item.position),
      radius: worldLength(item.radius),
      label: `${item.type} ${index + 1}`,
    })),
  }
}

/** Compute only the collision presentation that changes during playback. */
export function computeDynamicCollisionScene(
  state: DynamicOverlay,
  staticOverlay: StaticOverlay,
): DynamicCollisionScene {
  return {
    propLabels: staticOverlay.village.props.map((prop) => {
      const definition = propsByToken.get(prop.type)
      if (definition === undefined) throw new Error(`unknown prop type ${prop.type}`)
      const stateLabel = state.prop_states[prop.id]
      if (stateLabel === undefined) throw new Error(`missing prop state ${prop.id}`)
      return { id: prop.id, label: `${definition.title}: ${stateLabel}` }
    }),
    characterLabels: state.characters.map((character) => ({
      id: character.id,
      label: `${character.id}: ${character.expression === 'use' ? `using ${character.target}` : character.expression}`,
    })),
    characters: collisionBodies(state),
  }
}

/** Place every body for one frame. This is the only collision work an interpolated frame does. */
export function collisionBodies(state: DynamicOverlay): CollisionBody[] {
  return state.characters.map((character) => ({
    id: character.id,
    position: worldPoint(character.position),
    radius: worldLength(CHARACTER_RADIUS_METERS),
    headingEnd: worldPoint(headingEndpoint(character.position, character.heading)),
  }))
}
