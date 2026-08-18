import { Container, Rectangle, Sprite, Texture } from 'pixi.js'
import { describe, expect, it } from 'vitest'

import { THREE_BRANCHES_ASSET_CATALOG } from '../assets.js'
import { createRoofArt, createRoofLayer, roofTilePlan, type RoofArt } from './buildings.js'
import { HEARTHSIDE_STYLE, THREE_BRANCHES_PRESENTATION } from '../core/presentation.js'
import type { FrameScene, StaticDrawable, StaticScene, VillageStatic } from '../core/types.js'
import { buildStaticScene } from '../map/scene.js'
import type { FrameGrid } from '../ui/tint.js'

const CELL = THREE_BRANCHES_PRESENTATION.unitsPerMetre

function frameGrid(name: 'buildings'): FrameGrid {
  const atlas = THREE_BRANCHES_ASSET_CATALOG.find((item) => item.name === name)
  if (atlas === undefined || 'layers' in atlas) {
    throw new Error(`Three Branches ${name} atlas is missing.`)
  }
  return atlas.frames
}

function page(source: Texture['source']): Texture {
  const grid = frameGrid('buildings')
  return new Texture({ source, frame: new Rectangle(0, 0, grid.width, grid.height) })
}

function fakeRoofArt(): RoofArt {
  return createRoofArt(page(Texture.WHITE.source))
}

const homeBuilding: StaticDrawable = {
  id: 'home_0',
  type: 'home',
  label: 'home',
  shape: 'box',
  collisionScale: 1,
  rect: { x: 0, y: 0, width: 8 * CELL, height: 7 * CELL },
}

function staticScene(): StaticScene {
  const village: VillageStatic = {
    size: { cellsX: 8, cellsY: 7, cellSize: 1 },
    ground: [],
    buildings: [
      { id: 'home_0', type: 'home', cell: { x: 0, y: 0 } },
      { id: 'home_1', type: 'home', cell: { x: 9, y: 0 } },
    ],
    props: [],
    scenery: [],
    spawn: { x: 0, y: 0 },
  }
  return buildStaticScene(village)
}

function frameWithCharacters(
  scene: StaticScene,
  points: readonly (readonly [number, number])[],
): FrameScene {
  return {
    static: scene,
    dynamic: {
      tick: 1,
      phase: 'day',
      characters: points.map(([x, y], index) => ({
        id: `player_${index}`,
        x,
        y,
        heading: 0,
        moved: 0,
        expression: { type: 'none', target: '' },
      })),
      props: {},
      terminal: false,
    },
    presentationTick: 1,
    characters: [],
  }
}

describe('Three Branches roof tile planning', () => {
  it('tile plan covers every cell of an 8x7 home exactly once', () => {
    const treatment = HEARTHSIDE_STYLE.roofs.frames.home!
    const plan = roofTilePlan(homeBuilding, CELL)
    expect(plan).toHaveLength(56)
    expect(new Set(plan.map((tile) => `${tile.col},${tile.row}`)).size).toBe(56)

    const corners = plan.filter((tile) => tile.role === 'corner')
    expect(corners).toHaveLength(4)
    const rotations = corners.map((tile) => tile.rotation)
    expect(rotations).toHaveLength(4)
    expect(new Set(rotations)).toEqual(new Set([0, Math.PI / 2, Math.PI, -Math.PI / 2]))
    expect(corners.every((tile) => tile.frame === treatment.corner)).toBe(true)

    const edges = plan.filter((tile) => tile.role === 'edge')
    expect(edges).toHaveLength(22)
    const ridges = plan.filter((tile) => tile.role === 'ridge')
    expect(ridges).toHaveLength(6)
    expect(ridges.every((tile) => tile.row === 3)).toBe(true)
    expect(ridges.every((tile) => tile.frame === treatment.ridge)).toBe(true)
    const fills = plan.filter((tile) => tile.role === 'fill')
    expect(fills).toHaveLength(24)
    expect(fills.every((tile) => treatment.fills.includes(tile.frame))).toBe(true)

    expect(roofTilePlan(homeBuilding, CELL)).toEqual(plan)
  })
})

describe('Three Branches retained roof layer', () => {
  const scene = staticScene()
  const inside = () => frameWithCharacters(scene, [[4, 3]])
  const outside = () => frameWithCharacters(scene, [[1000, 1000]])

  it('installs one retained tile container per building with the plan', () => {
    const layer = new Container()
    const roofs = createRoofLayer(layer, scene)
    expect(layer.children.length).toBe(2)
    const home0 = layer.getChildByLabel('roof:home_0') as Container
    expect(home0.children.length).toBe(0)
    roofs.install(fakeRoofArt())
    expect(home0.children.length).toBe(56)
    expect(home0.children.every((child) => child instanceof Sprite)).toBe(true)
    const home1 = layer.getChildByLabel('roof:home_1') as Container
    expect(home1.children.length).toBe(56)
  })

  it('setTargets and advance are no-ops before install', () => {
    const layer = new Container()
    const roofs = createRoofLayer(layer, scene)
    expect(roofs.advance(110)).toBe(false)
    const home0 = layer.getChildByLabel('roof:home_0') as Container
    roofs.setTargets(inside(), false)
    expect(home0.alpha).toBe(1)
  })

  it('occupancy fixes target alpha and buildings stay independent', () => {
    const layer = new Container()
    const roofs = createRoofLayer(layer, scene)
    roofs.install(fakeRoofArt())
    expect(scene.buildings.find((building) => building.id === 'home_0')?.rect).toEqual({
      x: 0,
      y: 0,
      width: 8 * CELL,
      height: 7 * CELL,
    })
    roofs.setTargets(inside(), true)
    const home0 = layer.getChildByLabel('roof:home_0') as Container
    const home1 = layer.getChildByLabel('roof:home_1') as Container
    expect(home0.alpha).toBe(HEARTHSIDE_STYLE.roofs.clearAlpha)
    expect(home1.alpha).toBe(1)
    roofs.setTargets(outside(), true)
    expect(home0.alpha).toBe(1)
    expect(home1.alpha).toBe(1)
  })

  it('eases linearly at fadeMs and snaps on request', () => {
    const halfway = Math.round(HEARTHSIDE_STYLE.roofs.fadeMs / 2)
    const clearAlpha = HEARTHSIDE_STYLE.roofs.clearAlpha
    const halfwayAlpha = 1 - (1 - clearAlpha) / 2

    const easeLayer = new Container()
    const ease = createRoofLayer(easeLayer, scene)
    ease.install(fakeRoofArt())
    const easeHome = easeLayer.getChildByLabel('roof:home_0') as Container
    ease.setTargets(inside(), false)
    expect(easeHome.alpha).toBe(1)
    expect(ease.advance(halfway)).toBe(true)
    expect(easeHome.alpha).toBeCloseTo(halfwayAlpha, 5)
    expect(ease.advance(halfway)).toBe(true)
    expect(easeHome.alpha).toBe(clearAlpha)
    expect(ease.advance(0)).toBe(false)

    const reversalLayer = new Container()
    const reversal = createRoofLayer(reversalLayer, scene)
    reversal.install(fakeRoofArt())
    const reversalHome = reversalLayer.getChildByLabel('roof:home_0') as Container
    reversal.setTargets(inside(), false)
    expect(reversal.advance(halfway)).toBe(true)
    expect(reversalHome.alpha).toBeCloseTo(halfwayAlpha, 5)
    reversal.setTargets(outside(), false)
    expect(reversal.advance(halfway)).toBe(true)
    expect(reversalHome.alpha).toBe(1)
    expect(reversal.advance(0)).toBe(false)

    const snapLayer = new Container()
    const snap = createRoofLayer(snapLayer, scene)
    snap.install(fakeRoofArt())
    const snapHome = snapLayer.getChildByLabel('roof:home_0') as Container
    snap.setTargets(inside(), true)
    expect(snapHome.alpha).toBe(clearAlpha)
    expect(snap.advance(0)).toBe(false)
  })

  it('keeps child counts stable across setTargets and advance', () => {
    const layer = new Container()
    const roofs = createRoofLayer(layer, scene)
    roofs.install(fakeRoofArt())
    const home0 = layer.getChildByLabel('roof:home_0') as Container
    expect(home0.children.length).toBe(56)
    roofs.setTargets(inside(), false)
    roofs.advance(110)
    roofs.setTargets(outside(), false)
    roofs.advance(220)
    expect(home0.children.length).toBe(56)
  })

  it('throwing preflight leaves every building container childless', () => {
    const layer = new Container()
    const roofs = createRoofLayer(layer, scene)
    const art = fakeRoofArt() as Record<string, Texture>
    delete art['homeCorner']
    expect(() => roofs.install(art as RoofArt)).toThrow('roof frame is missing: homeCorner')
    const home0 = layer.getChildByLabel('roof:home_0') as Container
    expect(home0.children.length).toBe(0)
    roofs.install(fakeRoofArt())
    expect(home0.children.length).toBe(56)
  })
})
