import { Rectangle, Texture } from 'pixi.js'
import { describe, expect, it } from 'vitest'

import { THREE_BRANCHES_ASSET_CATALOG } from '../assets.js'
import type { StaticDrawable } from '../core/types.js'
import type { FrameGrid } from '../ui/tint.js'
import { frameRectangle } from '../ui/tint.js'
import { createPropArt, visualFacing } from './props-layer.js'

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
    expect(views.monuments.pumpFlowing?.frame).toEqual(
      frameRectangle(frameGrid('monuments'), 'pumpFlowing'),
    )
    expect(views.effects.flameA?.frame).toEqual(frameRectangle(frameGrid('effects'), 'flameA'))
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
