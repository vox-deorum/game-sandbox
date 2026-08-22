import { Container, Rectangle, Sprite, Texture } from 'pixi.js'
import { describe, expect, it } from 'vitest'

import { HEARTHSIDE_STYLE, THREE_BRANCHES_PRESENTATION } from '../core/presentation.js'
import type { FrameScene, StaticScene, VillageStatic } from '../core/types.js'
import { buildStaticScene } from '../map/scene.js'
import { buildingOccupied, createRoofArt, createRoofLayer, type RoofArt } from './buildings.js'

const CELL = THREE_BRANCHES_PRESENTATION.unitsPerMetre

const ROOF_PAGE_SIZES = {
  home: { width: 1024, height: 896 },
  inn: { width: 1536, height: 1280 },
  shed: { width: 1024, height: 1024 },
} as const

function page(width: number, height: number, source = Texture.WHITE.source): Texture {
  return new Texture({ source, frame: new Rectangle(0, 0, width, height) })
}

function roofPages(): RoofArt {
  return {
    home: page(ROOF_PAGE_SIZES.home.width, ROOF_PAGE_SIZES.home.height),
    inn: page(ROOF_PAGE_SIZES.inn.width, ROOF_PAGE_SIZES.inn.height),
    shed: page(ROOF_PAGE_SIZES.shed.width, ROOF_PAGE_SIZES.shed.height),
  }
}

function fakeRoofArt(): RoofArt {
  return createRoofArt(roofPages())
}

function staticScene(): StaticScene {
  const buildings = [
    { id: 'home_north', type: 'home', cell: { x: 0, y: 0 }, facing: 'north' },
    { id: 'home_east', type: 'home', cell: { x: 10, y: 0 }, facing: 'east' },
    { id: 'home_south', type: 'home', cell: { x: 20, y: 0 }, facing: 'south' },
    { id: 'home_west', type: 'home', cell: { x: 30, y: 0 }, facing: 'west' },
    { id: 'home_4', type: 'home', cell: { x: 40, y: 0 }, facing: 'north' },
    { id: 'inn_0', type: 'inn', cell: { x: 0, y: 12 }, facing: 'east' },
    { id: 'shed_0', type: 'shed', cell: { x: 15, y: 12 }, facing: 'south' },
  ] as unknown as VillageStatic['buildings']
  const village: VillageStatic = {
    size: { cellsX: 60, cellsY: 30, cellSize: 1 },
    ground: [],
    buildings,
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

function roofSprite(layer: Container, id: string): Sprite {
  const roof = layer.getChildByLabel(`roof:${id}`) as Container
  return roof.getChildByLabel('roof-sprite') as Sprite
}

describe('Three Branches full-roof art', () => {
  it('exposes the three validated semantic roof pages', () => {
    const pages = roofPages()
    const art = createRoofArt(pages)

    expect(art).toBe(pages)
    expect(art.home.frame).toEqual(new Rectangle(0, 0, 1024, 896))
    expect(art.inn.frame).toEqual(new Rectangle(0, 0, 1536, 1280))
    expect(art.shed.frame).toEqual(new Rectangle(0, 0, 1024, 1024))
  })

  it('rejects an incorrectly sized page before exposing any art', () => {
    const pages = {
      home: page(1024, 896),
      inn: page(1536, 1279),
      shed: page(1024, 1024),
    }
    expect(() => createRoofArt(pages)).toThrow(
      'Three Branches inn roof page must be one 1536x1280 frame.',
    )
  })
})

describe('Three Branches retained roof layer', () => {
  const scene = staticScene()
  const inside = () => frameWithCharacters(scene, [[4, 3]])
  const outside = () => frameWithCharacters(scene, [[1000, 1000]])

  it('installs one centered semantic sprite per building', () => {
    const layer = new Container()
    const roofs = createRoofLayer(layer, scene)
    const art = fakeRoofArt()
    roofs.install(art)

    expect(layer.children).toHaveLength(scene.buildings.length)
    const homes = scene.buildings.filter((building) => building.type === 'home')
    expect(homes).toHaveLength(5)
    for (const building of scene.buildings) {
      const roof = layer.getChildByLabel(`roof:${building.id}`) as Container
      const sprite = roofSprite(layer, building.id)
      expect(roof.children).toHaveLength(1)
      expect(sprite.texture).toBe(art[building.type as keyof RoofArt])
      expect(sprite.position).toMatchObject({
        x: building.rect.x + building.rect.width / 2,
        y: building.rect.y + building.rect.height / 2,
      })
      expect(sprite.scale.x).toBe(CELL / 128)
      expect(sprite.scale.y).toBe(CELL / 128)
    }
    expect(homes.map((building) => roofSprite(layer, building.id).texture)).toEqual([
      art.home,
      art.home,
      art.home,
      art.home,
      art.home,
    ])
    expect(roofSprite(layer, 'home_north').texture.frame).toEqual(new Rectangle(0, 0, 1024, 896))
    expect(roofSprite(layer, 'inn_0').texture.frame).toEqual(new Rectangle(0, 0, 1536, 1280))
    expect(roofSprite(layer, 'shed_0').texture.frame).toEqual(new Rectangle(0, 0, 1024, 1024))
  })

  it('rotates every facing around the semantic center, including swapped extents', () => {
    const layer = new Container()
    const roofs = createRoofLayer(layer, scene)
    roofs.install(fakeRoofArt())

    const rotations = {
      home_north: 0,
      home_east: Math.PI / 2,
      home_south: Math.PI,
      home_west: -Math.PI / 2,
    }
    for (const [id, rotation] of Object.entries(rotations)) {
      const building = scene.buildings.find((item) => item.id === id)!
      const sprite = roofSprite(layer, id)
      expect(sprite.rotation).toBe(rotation)
      expect(sprite.position).toMatchObject({
        x: building.rect.x + building.rect.width / 2,
        y: building.rect.y + building.rect.height / 2,
      })
    }

    const north = scene.buildings.find((item) => item.id === 'home_north')!
    const east = scene.buildings.find((item) => item.id === 'home_east')!
    const northSprite = roofSprite(layer, north.id)
    const eastSprite = roofSprite(layer, east.id)
    expect(northSprite.texture.frame.width * northSprite.scale.x).toBe(north.rect.width)
    expect(northSprite.texture.frame.height * northSprite.scale.y).toBe(north.rect.height)
    expect(eastSprite.texture.frame.height * eastSprite.scale.y).toBe(east.rect.width)
    expect(eastSprite.texture.frame.width * eastSprite.scale.x).toBe(east.rect.height)
  })

  it('setTargets and advance are no-ops before install', () => {
    const layer = new Container()
    const roofs = createRoofLayer(layer, scene)
    expect(roofs.advance(110)).toBe(false)
    const home = layer.getChildByLabel('roof:home_north') as Container
    roofs.setTargets(inside(), false)
    expect(home.alpha).toBe(1)
  })

  it('occupancy fixes target alpha and buildings stay independent', () => {
    const layer = new Container()
    const roofs = createRoofLayer(layer, scene)
    roofs.install(fakeRoofArt())
    roofs.setTargets(inside(), true)
    const home = layer.getChildByLabel('roof:home_north') as Container
    const otherHome = layer.getChildByLabel('roof:home_east') as Container
    expect(home.alpha).toBe(HEARTHSIDE_STYLE.roofs.clearAlpha)
    expect(otherHome.alpha).toBe(1)
    roofs.setTargets(outside(), true)
    expect(home.alpha).toBe(1)
    expect(otherHome.alpha).toBe(1)
  })

  it('shares semantic building occupancy with other retained layers', () => {
    const building = scene.buildings.find((item) => item.id === 'home_north')
    if (building === undefined) throw new Error('home_north fixture building is missing.')
    expect(buildingOccupied(inside(), building)).toBe(true)
    expect(buildingOccupied(outside(), building)).toBe(false)
  })

  it('eases linearly at fadeMs and snaps on request', () => {
    const halfway = Math.round(HEARTHSIDE_STYLE.roofs.fadeMs / 2)
    const clearAlpha = HEARTHSIDE_STYLE.roofs.clearAlpha
    const halfwayAlpha = 1 - (1 - clearAlpha) / 2

    const easeLayer = new Container()
    const ease = createRoofLayer(easeLayer, scene)
    ease.install(fakeRoofArt())
    const easeHome = easeLayer.getChildByLabel('roof:home_north') as Container
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
    const reversalHome = reversalLayer.getChildByLabel('roof:home_north') as Container
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
    const snapHome = snapLayer.getChildByLabel('roof:home_north') as Container
    snap.setTargets(inside(), true)
    expect(snapHome.alpha).toBe(clearAlpha)
    expect(snap.advance(0)).toBe(false)
  })

  it('keeps one child per roof across target changes and easing', () => {
    const layer = new Container()
    const roofs = createRoofLayer(layer, scene)
    roofs.install(fakeRoofArt())
    const home = layer.getChildByLabel('roof:home_north') as Container
    expect(home.children).toHaveLength(1)
    roofs.setTargets(inside(), false)
    roofs.advance(110)
    roofs.setTargets(outside(), false)
    roofs.advance(220)
    expect(home.children).toHaveLength(1)
  })

  it('keeps every container childless after preflight failure and permits a retry', () => {
    const layer = new Container()
    const roofs = createRoofLayer(layer, scene)
    const invalid = { ...roofPages(), shed: page(1024, 1023) }
    expect(() => roofs.install(invalid)).toThrow(
      'Three Branches shed roof page must be one 1024x1024 frame.',
    )
    for (const building of scene.buildings) {
      expect((layer.getChildByLabel(`roof:${building.id}`) as Container).children).toHaveLength(0)
    }
    roofs.install(fakeRoofArt())
    for (const building of scene.buildings) {
      expect((layer.getChildByLabel(`roof:${building.id}`) as Container).children).toHaveLength(1)
    }
  })
})
