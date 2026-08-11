import { Container, Text } from 'pixi.js'
import { describe, expect, it } from 'vitest'
import { computeDynamicCollisionScene, computeStaticCollisionScene } from './collision.js'
import { CollisionLayer } from './collision-layer.js'
import { decodeDynamic } from './overlay.js'
import { PALETTE } from './scene.js'
import { states, staticOverlay } from './test-helpers.js'

describe('Three Branches retained collision layer', () => {
  it('mounts static geometry once and retains every static node across dynamic frames', () => {
    const layer = new CollisionLayer(PALETTE)
    const staticScene = computeStaticCollisionScene(staticOverlay)
    layer.mountStatic(staticScene)
    const staticNodes = [...layer.staticView.children]
    const first = decodeDynamic(states[0], staticOverlay)
    const second = structuredClone(first)
    second.prop_states.stall_0 = 'open'
    const secondCharacter = second.characters[0]
    if (secondCharacter === undefined) throw new Error('fixture has no collision character')
    secondCharacter.position.x += 1

    layer.mountStatic(staticScene)
    layer.updateDynamic(computeDynamicCollisionScene(first, staticOverlay), true, 2)
    const dynamicNodes = [...layer.dynamicView.children]
    const secondScene = computeDynamicCollisionScene(second, staticOverlay)
    layer.updateDynamic(secondScene, true, 2)

    expect(layer.snapshot()).toEqual({ staticBuilds: 1, dynamicUpdates: 2 })
    expect(layer.staticView.children).toEqual(staticNodes)
    expect(layer.dynamicView.children).toEqual(dynamicNodes)
    expect(labelFor(layer.staticView, 'stall_0').text).toBe('Market stall: open')
    expect(rootFor(layer.dynamicView, secondCharacter.id).x).toBe(
      secondScene.characters[0]?.position.x,
    )
    layer.destroy()
  })

  it('does no dynamic collision work while the overlay is hidden', () => {
    const layer = new CollisionLayer(PALETTE)
    layer.mountStatic(computeStaticCollisionScene(staticOverlay))
    const first = decodeDynamic(states[0], staticOverlay)
    const second = structuredClone(first)
    second.prop_states.stall_0 = 'open'
    const dynamic = computeDynamicCollisionScene(first, staticOverlay)
    layer.updateDynamic(dynamic, true, 2)
    const nodes = [...layer.dynamicView.children]

    layer.updateDynamic(computeDynamicCollisionScene(second, staticOverlay), false, 2)

    expect(layer.view.visible).toBe(false)
    expect(layer.snapshot()).toEqual({ staticBuilds: 1, dynamicUpdates: 1 })
    expect(layer.dynamicView.children).toEqual(nodes)
    expect(labelFor(layer.staticView, 'stall_0').text).toBe('Market stall: closed')
    layer.destroy()
  })
})

function rootFor(view: Container, id: string): Container {
  const root = view.children.find((child) => child.label === id)
  if (!(root instanceof Container)) throw new Error(`collision layer has no ${id} node`)
  return root
}

function labelFor(view: Container, id: string): Text {
  const label = rootFor(view, id).children.find((child) => child instanceof Text)
  if (!(label instanceof Text)) throw new Error(`collision layer has no ${id} label`)
  return label
}
