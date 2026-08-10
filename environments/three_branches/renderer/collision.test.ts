import { describe, expect, it } from 'vitest'

import { computeCollisionScene } from './collision.js'
import {
  buildingWallSegments,
  CHARACTER_RADIUS_METERS,
  footprintCorners,
  headingEndpoint,
  WORLD_SCALE,
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
    frame.d.c[0] = `${frame.d.c[0]?.slice(0, 11)}1z`
    const state = decodeDynamic(frame, staticOverlay)
    const scene = computeCollisionScene(state, staticOverlay)
    expect(scene.buildings).toHaveLength(7)
    expect(scene.waterBanks).toHaveLength(24)
    expect(scene.confluences).toHaveLength(1)
    expect(scene.boundaries).toHaveLength(4)
    expect(scene.props).toHaveLength(31)
    expect(scene.scenery).toHaveLength(17)
    expect(scene.characters).toHaveLength(6)
    expect(scene.props.find((prop) => prop.id === 'stall_0')?.label).toBe('Market stall: closed')
    expect(scene.characters[0]?.radius).toBe(CHARACTER_RADIUS_METERS * WORLD_SCALE)
    expect(scene.characters[0]?.expression).toBe('wave')
    expect(scene.buildings[0]?.walls[0]?.radius).toBe(0.05 * WORLD_SCALE)
    expect(scene.waterBanks[0]).toMatchObject({
      id: 'water_bank_0',
      start: { x: 47 * WORLD_SCALE, y: 100 * WORLD_SCALE },
      end: { x: 47 * WORLD_SCALE, y: 65 * WORLD_SCALE },
      radius: 0.05 * WORLD_SCALE,
      label: 'Water bank 1',
    })
    expect(scene.waterBanks[3]).toMatchObject({
      id: 'water_bank_3',
      start: { x: 411.6816246199819, y: 784.7623270984699 },
      end: { x: 352.25640426719593, y: 432.1253000681646 },
      radius: 0.05 * WORLD_SCALE,
      label: 'Water bank 4',
    })
    expect(scene.waterBanks[18]).toMatchObject({
      id: 'water_bank_18',
      start: { x: 330.3988480975957, y: 382.3901607189551 },
      end: { x: 450.0765853645307, y: 391.17874437427093 },
      radius: 0.05 * WORLD_SCALE,
      label: 'Water bank 19',
    })
    expect(scene.confluences[0]).toEqual({
      id: 'water_confluence_0',
      center: { x: 50 * WORLD_SCALE, y: 65 * WORLD_SCALE },
      radius: 3 * WORLD_SCALE,
      label: 'Water confluence 1',
    })
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
    expect(scene.scenery[0]).toEqual({
      id: 'pine_0',
      center: { x: 4 * WORLD_SCALE, y: 55 * WORLD_SCALE },
      radius: 0.8 * WORLD_SCALE,
      label: 'pine 1',
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
