import { Container, Rectangle, Sprite, Texture } from 'pixi.js'
import { describe, expect, it } from 'vitest'

import { THREE_BRANCHES_ASSET_CATALOG } from '../assets.js'
import { sceneryVisualScale } from '../core/presentation.js'
import type { StaticDrawable, StaticScene } from '../core/types.js'
import type { FrameGrid } from '../ui/tint.js'
import { frameRectangle } from '../ui/tint.js'
import {
  createPropArt,
  createPropLayer,
  type PropLayerTargets,
  visualFacing,
} from './props-layer.js'

type PageName = 'props' | 'monuments' | 'scenery' | 'effects'

function frameGrid(name: PageName): FrameGrid {
  const atlas = THREE_BRANCHES_ASSET_CATALOG.find((item) => item.name === name)
  if (atlas === undefined || 'layers' in atlas) {
    throw new Error(`Three Branches ${name} atlas is missing.`)
  }
  return atlas.frames
}

function page(name: PageName, source: Texture['source']): Texture {
  const grid = frameGrid(name)
  return new Texture({ source, frame: new Rectangle(0, 0, grid.width, grid.height) })
}

function layerTargets(): PropLayerTargets {
  return {
    scenery: new Container(),
    shadows: new Container(),
    props: new Container(),
    effects: new Container(),
    emissives: new Container(),
    highlight: new Container(),
  }
}

function sceneryScene(): StaticScene {
  const scenery = (id: string, type: string, collisionScale: number): StaticDrawable => ({
    id,
    type,
    label: type,
    shape: 'circle',
    collisionScale,
    rect: { x: 10, y: 20, width: 8, height: 8 },
  })
  return {
    village: {
      size: { cellsX: 1, cellsY: 1, cellSize: 1 },
      ground: ['.'],
      buildings: [],
      props: [],
      scenery: [],
      spawn: { x: 0, y: 0 },
    },
    world: { width: 1, height: 1 },
    spawn: { x: 0, y: 0 },
    ground: [],
    groundByCode: {},
    topFirstRows: ['.'],
    buildings: [],
    props: [],
    scenery: [scenery('pine-1', 'pine', 0.75), scenery('crate-1', 'crate', 0.4)],
  }
}

function completeArt() {
  const source = Texture.WHITE.source
  return createPropArt({
    props: page('props', source),
    monuments: page('monuments', source),
    scenery: page('scenery', source),
    effects: page('effects', source),
  })
}

describe('Three Branches prop art views', () => {
  it('slices named views over their atlas source with manifest rectangles', () => {
    const source = Texture.WHITE.source
    const views = createPropArt({
      props: page('props', source),
      monuments: page('monuments', source),
      scenery: page('scenery', source),
      effects: page('effects', source),
    })

    // Every named view resolves to the manifest rectangle on its own atlas page, with the bell
    // foundation living only in the monuments atlas. The exact offsets are atlas calibration, so
    // they come from the manifest rather than being pinned in this suite.
    expect(views.props.stallOpen?.source).toBe(source)
    expect(views.props.stallOpen?.frame).toEqual(frameRectangle(frameGrid('props'), 'stallOpen'))
    expect(views.props.bellFoundation).toBeUndefined()
    expect(views.monuments.bellFoundation?.frame).toEqual(
      frameRectangle(frameGrid('monuments'), 'bellFoundation'),
    )
    expect(views.scenery.marketCrate?.frame).toEqual(
      frameRectangle(frameGrid('scenery'), 'marketCrate'),
    )
    expect(views.scenery.pineA?.frame).toEqual(new Rectangle(0, 0, 512, 512))
    expect(views.scenery.pineF?.frame).toEqual(new Rectangle(512, 512, 512, 512))
    expect(views.scenery.marketCrate?.frame).toEqual(new Rectangle(1024, 512, 512, 512))
    expect(views.monuments.pumpFlowing?.frame).toEqual(
      frameRectangle(frameGrid('monuments'), 'pumpFlowing'),
    )
    expect(views.effects.flameA?.frame).toEqual(frameRectangle(frameGrid('effects'), 'flameA'))
  })

  it('installs full-color scenery at one eighth of its configured visual scale', () => {
    const targets = layerTargets()
    const props = createPropLayer(targets, sceneryScene())
    props.install(completeArt())

    const pineRoot = targets.scenery.getChildByLabel('scenery:pine-1')
    const crateRoot = targets.scenery.getChildByLabel('scenery:crate-1')
    expect(pineRoot).toBeInstanceOf(Container)
    expect(crateRoot).toBeInstanceOf(Container)
    const pine = (pineRoot as Container).getChildByLabel('scenery-art')
    const crate = (crateRoot as Container).getChildByLabel('scenery-art')
    expect(pine).toBeInstanceOf(Sprite)
    expect(crate).toBeInstanceOf(Sprite)
    expect((pine as Sprite).scale.x).toBe((sceneryVisualScale('pine') * 0.75) / 8)
    expect((crate as Sprite).scale.x).toBe((sceneryVisualScale('crate') * 0.4) / 8)
    expect((pine as Sprite).tint).toBe(0xffffff)
    expect((crate as Sprite).tint).toBe(0xffffff)
  })

  it('preflights every approved pine frame', () => {
    const targets = layerTargets()
    const props = createPropLayer(targets, sceneryScene())
    const art = completeArt()
    const scenery = Object.fromEntries(
      Object.entries(art.scenery).filter(([name]) => name !== 'pineF'),
    )

    expect(() => props.install({ ...art, scenery })).toThrow(/prop frame is missing: pineF/)
  })
})

describe('Three Branches prop visual facing', () => {
  const drawable = (type: string, facing?: string): StaticDrawable => ({
    id: `${type}-test`,
    type,
    label: type,
    shape: 'box',
    collisionScale: 1,
    rect: { x: 0, y: 0, width: 1, height: 1 },
    facing,
  })

  it('turns an east-facing bench by a quarter turn', () => {
    expect(visualFacing(drawable('bench', 'east'))).toBe(Math.PI / 2)
  })

  it('keeps an east-facing lantern fixed north', () => {
    expect(visualFacing(drawable('lantern', 'east'))).toBe(0)
  })

  it('keeps an east-facing shrine fixed north', () => {
    expect(visualFacing(drawable('shrine', 'east'))).toBe(0)
  })

  it('keeps an east-facing monument fixed north', () => {
    expect(visualFacing(drawable('pump', 'east'))).toBe(0)
  })

  it('defaults an undefined facing to north', () => {
    expect(visualFacing(drawable('bench'))).toBe(0)
  })
})
