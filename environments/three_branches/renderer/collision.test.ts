import { describe, expect, it } from 'vitest'

import { computeCollisionScene } from './collision.js'
import {
  buildingWallSegments,
  CHARACTER_RADIUS_METERS,
  footprintCorners,
  headingEndpoint,
  STATIC_SEGMENT_RADIUS_METERS,
  waterBankSegments,
  waterConfluenceDisks,
  WORLD_SCALE,
  worldLength,
  worldPoint,
} from './geometry.js'
import { decodeDynamic, decodeStatic } from './overlay.js'
import { header, states } from './test-helpers.js'

describe('Three Branches collision geometry', () => {
  const staticOverlay = decodeStatic(header.overlay_static)

  it('splits every building perimeter around its doorway gap', () => {
    for (const building of staticOverlay.village.buildings) {
      const walls = buildingWallSegments(building)
      expect(walls).toHaveLength(5)
      expect(
        walls.some(
          (wall) =>
            (wall.start.x === building.doorway.position.x &&
              wall.start.y === building.doorway.position.y) ||
            (wall.end.x === building.doorway.position.x &&
              wall.end.y === building.doorway.position.y),
        ),
      ).toBe(false)
    }
    const firstBuilding = staticOverlay.village.buildings[0]
    expect(firstBuilding).toBeDefined()
    if (!firstBuilding) throw new Error('fixture has no first building')
    const edgeDoorway = {
      ...firstBuilding,
      center: { x: 0, y: 0 },
      width: 4,
      depth: 4,
      rotation: 0,
      doorway: { position: { x: -2, y: -2 }, width: 1.2 },
    }
    expect(buildingWallSegments(edgeDoorway)).toHaveLength(4)
  })

  it('rotates footprint corners and heading ticks in meter space before scale conversion', () => {
    const corners = footprintCorners({ x: 0, y: 0 }, 2, 4, 90)
    for (const [index, expected] of [
      [2, -1],
      [2, 1],
      [-2, 1],
      [-2, -1],
    ].entries()) {
      expect(corners[index]?.x).toBeCloseTo(expected[0] ?? 0)
      expect(corners[index]?.y).toBeCloseTo(expected[1] ?? 0)
    }
    expect(headingEndpoint({ x: 3, y: 4 }, 90)).toEqual({ x: 3, y: 4.4 })
  })

  it('keeps collision drawables keyed and labelled at collision truth', () => {
    const frame = structuredClone(states[0]) as {
      v: number
      d: { t: number; c: string[]; p: string; z: string }
    }
    frame.d.c[0] = `${frame.d.c[0]?.slice(0, 11)}1zz`
    const state = decodeDynamic(frame, staticOverlay)
    const scene = computeCollisionScene(state, staticOverlay)
    expect(scene.buildings).toHaveLength(7)
    expect(scene.waterBanks).toEqual(
      waterBankSegments(staticOverlay.village).map((segment, index) => ({
        id: `water_bank_${index}`,
        start: worldPoint(segment.start),
        end: worldPoint(segment.end),
        radius: worldLength(STATIC_SEGMENT_RADIUS_METERS),
        label: `Water bank ${index + 1}`,
      })),
    )
    expect(scene.confluences).toHaveLength(1)
    expect(scene.boundaries).toHaveLength(4)
    expect(scene.props).toHaveLength(staticOverlay.village.props.length)
    expect(scene.scenery).toHaveLength(staticOverlay.village.scenery.length)
    expect(scene.characters).toHaveLength(6)
    expect(scene.props.find((prop) => prop.id === 'stall_0')?.label).toBe('Market stall: closed')
    expect(scene.characters[0]?.radius).toBe(CHARACTER_RADIUS_METERS * WORLD_SCALE)
    expect(scene.characters[0]?.expression).toBe('wave')
    expect(scene.buildings[0]?.walls[0]?.radius).toBe(0.05 * WORLD_SCALE)
    expect(scene.confluences).toEqual(
      waterConfluenceDisks(staticOverlay.village).map((disk, index) => ({
        id: `water_confluence_${index}`,
        center: worldPoint(disk.center),
        radius: worldLength(disk.radius),
        label: `Water confluence ${index + 1}`,
      })),
    )
    expect(scene.boundaries).toEqual([
      {
        id: 'world_boundary_0',
        start: { x: 0, y: 0 },
        end: { x: 100 * WORLD_SCALE, y: 0 },
        radius: 0.05 * WORLD_SCALE,
        label: 'World boundary 1',
      },
      {
        id: 'world_boundary_1',
        start: { x: 100 * WORLD_SCALE, y: 0 },
        end: { x: 100 * WORLD_SCALE, y: 100 * WORLD_SCALE },
        radius: 0.05 * WORLD_SCALE,
        label: 'World boundary 2',
      },
      {
        id: 'world_boundary_2',
        start: { x: 100 * WORLD_SCALE, y: 100 * WORLD_SCALE },
        end: { x: 0, y: 100 * WORLD_SCALE },
        radius: 0.05 * WORLD_SCALE,
        label: 'World boundary 3',
      },
      {
        id: 'world_boundary_3',
        start: { x: 0, y: 100 * WORLD_SCALE },
        end: { x: 0, y: 0 },
        radius: 0.05 * WORLD_SCALE,
        label: 'World boundary 4',
      },
    ])
    const firstScenery = staticOverlay.village.scenery[0]
    expect(firstScenery).toBeDefined()
    if (!firstScenery) throw new Error('fixture has no scenery')
    expect(scene.scenery[0]).toEqual({
      id: `${firstScenery.type}_0`,
      center: worldPoint(firstScenery.position),
      radius: worldLength(firstScenery.radius),
      label: `${firstScenery.type} 1`,
    })
    expect(new Set(scene.buildings.map((building) => building.id)).size).toBe(
      scene.buildings.length,
    )
    expect(new Set(scene.props.map((prop) => prop.id)).size).toBe(scene.props.length)
    expect(new Set(scene.waterBanks.map((bank) => bank.id)).size).toBe(scene.waterBanks.length)
    expect(new Set(scene.confluences.map((disk) => disk.id)).size).toBe(scene.confluences.length)
    expect(new Set(scene.boundaries.map((boundary) => boundary.id)).size).toBe(
      scene.boundaries.length,
    )
    expect(new Set(scene.scenery.map((scenery) => scenery.id)).size).toBe(scene.scenery.length)
    expect(new Set(scene.characters.map((character) => character.id)).size).toBe(
      scene.characters.length,
    )
  })
})
