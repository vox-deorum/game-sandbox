import { Rectangle, Texture } from 'pixi.js'
import { describe, expect, it } from 'vitest'

import { createPropArt } from './props-layer.js'

describe('Three Branches prop art views', () => {
  it('slices named views over their atlas source with manifest rectangles', () => {
    const source = Texture.WHITE.source
    const props = new Texture({ source, frame: new Rectangle(0, 0, 2304, 1536) })
    const monuments = new Texture({ source, frame: new Rectangle(0, 0, 2304, 1024) })
    const scenery = new Texture({ source, frame: new Rectangle(0, 0, 128, 128) })
    const effects = new Texture({ source, frame: new Rectangle(0, 0, 1344, 512) })
    const views = createPropArt({ props, monuments, scenery, effects })
    expect(views.props.stallOpen?.source).toBe(source)
    expect(views.props.stallOpen?.frame).toMatchObject({ x: 0, y: 0, width: 384, height: 256 })
    expect(views.props.bellFoundation).toBeUndefined()
    expect(views.monuments.bellFoundation?.frame).toMatchObject({
      x: 768,
      y: 512,
      width: 768,
      height: 512,
    })
    expect(views.scenery.marketCrate?.frame).toMatchObject({ x: 64, y: 64, width: 64, height: 64 })
    expect(views.monuments.pumpFlowing?.frame).toMatchObject({
      x: 0,
      y: 0,
      width: 768,
      height: 512,
    })
    expect(views.effects.flameA?.frame).toMatchObject({ x: 768, y: 0, width: 192, height: 128 })
  })
})
