import { Container } from 'pixi.js'
import { describe, expect, it } from 'vitest'

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
  it('draws shared texture outlines below scenery and interactive props', () => {
    const stack = createWorldArtStack(mapView())

    expect(stack.authored.children.map((child) => child.label)).toEqual([
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

  it('toggles one retained night filter over world art without grading overlays', () => {
    const stack = createWorldArtStack(mapView())
    const worldArt = stack.root.getChildByLabel('world-art') as Container

    expect(worldArt.children).toEqual([stack.natural, stack.authored])
    expect(stack.root.children).toEqual([
      worldArt,
      stack.emissives,
      stack.highlight,
      stack.annotations,
      stack.collision,
    ])
    expect(worldArt.filters ?? []).toEqual([])

    stack.setNightGrade(true)
    expect(worldArt.filters).toHaveLength(1)
    const retainedFilter = worldArt.filters[0]
    stack.setNightGrade(true)
    expect(worldArt.filters[0]).toBe(retainedFilter)

    stack.setNightGrade(false)
    expect(worldArt.filters).toEqual([])
    stack.destroy()
  })
})
