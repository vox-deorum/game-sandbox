import { Rectangle, Texture } from 'pixi.js'
import { describe, expect, it } from 'vitest'

import { THREE_BRANCHES_ASSET_CATALOG } from '../assets.js'
import type { FrameGrid } from '../ui/tint.js'
import { frameRectangle } from '../ui/tint.js'
import { createPropArt } from './props-layer.js'

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
