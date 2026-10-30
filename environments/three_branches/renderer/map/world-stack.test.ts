import { Container } from 'pixi.js'
import { describe, expect, it } from 'vitest'

import { dayLightAt } from '../effects/post-effects.js'
import type { MapLayerView } from './map-layer.js'
import { createWorldArtStack } from './world-stack.js'

function mapView(): MapLayerView {
  return {
    naturalView: new Container({ label: 'terrain' }),
    architectureView: new Container({ label: 'architecture' }),
    span: { width: 16, height: 16 },
    destroy() {},
  }
}

describe('Three Branches world art stack', () => {
  it('moves the camera as one render group transform', () => {
    const stack = createWorldArtStack(mapView())
    expect(stack.root.isRenderGroup).toBe(true)
    stack.destroy()
  })

  it('draws shared texture outlines below scenery and interactive props', () => {
    const stack = createWorldArtStack(mapView())
    const worldArt = stack.root.getChildByLabel('world-art') as Container
    const authored = worldArt.getChildByLabel('world-authored') as Container

    expect(authored.children.map((child) => child.label)).toEqual([
      'architecture',
      'prop-outlines',
      'scenery',
      'props',
      'characters',
      'upper',
      'roofs',
      'effects',
    ])
    stack.destroy()
  })

  it('grades world art with one retained filter that detaches at midday', () => {
    const stack = createWorldArtStack(mapView())
    const worldArt = stack.root.getChildByLabel('world-art') as Container

    expect(worldArt.children.map((child) => child.label)).toEqual([
      'world-natural',
      'world-authored',
      'cranes',
      'clouds',
    ])
    expect(stack.root.children).toEqual([
      worldArt,
      stack.emissives,
      stack.highlight,
      stack.annotations,
      stack.collision,
    ])
    expect(worldArt.filters ?? []).toEqual([])

    stack.setDayLight(dayLightAt('night', 1080))
    expect(worldArt.filters).toHaveLength(1)
    const retainedFilter = worldArt.filters[0]
    stack.setDayLight(dayLightAt('evening', 900))
    expect(worldArt.filters[0]).toBe(retainedFilter)

    stack.setDayLight(dayLightAt('midday', 600.5))
    expect(worldArt.filters).toEqual([])
    stack.setDayLight(dayLightAt('day', 1080))
    expect(worldArt.filters).toEqual([])
    stack.destroy()
  })
})
