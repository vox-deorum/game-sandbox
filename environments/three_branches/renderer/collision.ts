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

export interface CollisionScene {
  buildings: Array<{
    id: string
    label: string
    walls: Array<{ start: Point; end: Point; radius: number }>
  }>
  waterBanks: CollisionSegments
  confluences: CollisionCircles
  boundaries: CollisionSegments
  props: Array<{ id: string; corners: Point[]; label: string }>
  scenery: CollisionCircles
  characters: Array<{
    id: string
    center: Point
    radius: number
    headingEnd: Point
    expression: string
  }>
}

type CollisionSegments = Array<{
  id: string
  start: Point
  end: Point
  radius: number
  label: string
}>

type CollisionCircles = Array<{ id: string; center: Point; radius: number; label: string }>

const propsByToken = new Map(propsData.props.map((prop) => [prop.token, prop]))

/** Compute the view of exactly the shapes the engine collides against. */
export function computeCollisionScene(
  state: DynamicOverlay,
  staticOverlay: StaticOverlay,
): CollisionScene {
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
      if (!definition) throw new Error(`unknown prop type ${prop.type}`)
      const stateLabel = state.prop_states[prop.id]
      if (!stateLabel) throw new Error(`missing prop state ${prop.id}`)
      return {
        id: prop.id,
        corners: footprintCorners(
          prop.position,
          definition.footprint.width,
          definition.footprint.depth,
          prop.rotation,
        ).map(worldPoint),
        label: `${definition.title}: ${stateLabel}`,
      }
    }),
    scenery: staticOverlay.village.scenery.map((item, index) => ({
      id: `${item.type}_${index}`,
      center: worldPoint(item.position),
      radius: worldLength(item.radius),
      label: `${item.type} ${index + 1}`,
    })),
    characters: state.characters.map((character) => ({
      id: character.id,
      center: worldPoint(character.position),
      radius: worldLength(CHARACTER_RADIUS_METERS),
      headingEnd: worldPoint(headingEndpoint(character.position, character.heading)),
      expression:
        character.expression === 'use' ? `using ${character.target}` : character.expression,
    })),
  }
}
