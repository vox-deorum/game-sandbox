import { Container, Rectangle, Sprite, Texture } from 'pixi.js'
import { describe, expect, it } from 'vitest'

import { THREE_BRANCHES_ASSET_CATALOG } from './assets.js'
import { createPropArt, createPropLayer, hasSustainedPropEffectTransition, type PropArt } from './props-layer.js'
import { expectedCharacterIds, readStatic } from './overlay.js'
import { buildStaticScene, computeScene } from './scene.js'
import { fixtureRecording } from './test-helpers.js'

function frameMap(
  name: 'props' | 'monuments' | 'scenery' | 'effects',
): Readonly<Record<string, Texture>> {
  const atlas = THREE_BRANCHES_ASSET_CATALOG.find((item) => item.name === name)
  if (atlas === undefined || 'layers' in atlas) throw new Error(`Missing ${name} atlas.`)
  return Object.fromEntries(atlas.frames.names.map((frame) => [frame, Texture.WHITE]))
}

function art(): PropArt {
  return {
    props: frameMap('props'),
    monuments: frameMap('monuments'),
    scenery: frameMap('scenery'),
    effects: frameMap('effects'),
  }
}

function scene() {
  const { header, states } = fixtureRecording()
  const staticScene = buildStaticScene(readStatic(header))
  return computeScene(states[0] as (typeof states)[number], staticScene, expectedCharacterIds(header))
}

function node(root: Container, label: string): Container {
  const found = root.children.find((child) => child.label === label)
  if (!(found instanceof Container)) throw new Error(`Missing ${label}.`)
  return found
}

function spriteNode(root: Container, label: string): Sprite {
  const found = root.children.find((child) => child.label === label)
  if (!(found instanceof Sprite)) throw new Error(`Missing sprite ${label}.`)
  return found
}

describe('Three Branches retained props', () => {
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
    expect(views.monuments.bellFoundation?.frame).toMatchObject({ x: 768, y: 512, width: 768, height: 512 })
    expect(views.scenery.marketCrate?.frame).toMatchObject({ x: 64, y: 64, width: 64, height: 64 })
    expect(views.monuments.pumpFlowing?.frame).toMatchObject({ x: 0, y: 0, width: 768, height: 512 })
    expect(views.effects.flameA?.frame).toMatchObject({ x: 768, y: 0, width: 192, height: 128 })
  })

  it('anchors tightly authored monuments at their collision points without changing world scale', () => {
    const frame = scene()
    const scenery = new Container()
    const props = new Container()
    const upper = new Container()
    const layer = createPropLayer(scenery, props, upper, new Container(), frame.static)
    const source = Texture.WHITE.source
    const installed = createPropArt({
      props: new Texture({ source, frame: new Rectangle(0, 0, 2304, 1536) }),
      monuments: new Texture({ source, frame: new Rectangle(0, 0, 2304, 1024) }),
      scenery: new Texture({ source, frame: new Rectangle(0, 0, 128, 128) }),
      effects: new Texture({ source, frame: new Rectangle(0, 0, 1344, 512) }),
    })
    layer.install(installed)

    const bell = frame.static.props.find((item) => item.type === 'bell')
    const pump = frame.static.props.find((item) => item.type === 'pump')
    if (bell === undefined || pump === undefined) throw new Error('Fixture needs bell and pump.')
    const bellStill = spriteNode(node(upper, `prop:${bell.id}`), 'prop-still')
    const pumpStill = spriteNode(node(upper, `prop:${pump.id}`), 'prop-still')
    const foundation = props.children.find(
      (child) => child.label === 'prop-foundation' && child.visible,
    )
    if (!(foundation instanceof Sprite)) throw new Error('Fixture has no bell foundation.')

    expect(bellStill.scale.x).toBe(0.36 / 8)
    expect(bellStill.anchor).toMatchObject({ x: 0.5, y: 480 / 512 })
    expect(foundation.scale.x).toBe(0.36 / 8)
    expect(foundation.anchor).toMatchObject({ x: 0.5, y: 0.5 })
    expect(pumpStill.scale.x).toBe(0.33 / 4)
    expect(pumpStill.anchor).toMatchObject({ x: 344 / 768, y: 0.75 })
  })

  it('retains state nodes and leaves fallback untouched when complete art preflight fails', () => {
    const frame = scene()
    const scenery = new Container()
    const props = new Container()
    const upper = new Container()
    const emissives = new Container()
    const layer = createPropLayer(scenery, props, upper, emissives, frame.static)
    const hearthId = frame.static.props.find((item) => item.type === 'hearth')?.id
    if (hearthId === undefined) throw new Error('Fixture has no hearth.')
    const hearth = node(props, `prop:${hearthId}`)
    expect(node(hearth, 'prop-fallback').visible).toBe(true)
    const missing = { ...art(), props: { ...frameMap('props') } }
    delete (missing.props as Record<string, Texture>).hearthLit
    expect(() => layer.install(missing)).toThrow(/prop frame is missing/)
    expect(node(hearth, 'prop-fallback').visible).toBe(true)

    layer.install(art())
    layer.reconcile(frame)
    expect(node(hearth, 'prop-fallback').visible).toBe(false)
    const still = spriteNode(hearth, 'prop-still')
    expect(still.visible).toBe(true)
    expect(still.texture).toBe(Texture.WHITE)
    layer.reconcile(frame)
    expect(spriteNode(hearth, 'prop-still')).toBe(still)

    const crate = node(scenery, 'scenery:scenery:0')
    expect(crate.position.x).toBe(frame.static.scenery[0]?.rect.x! + frame.static.scenery[0]?.rect.width! / 2)
    expect(crate.getChildByLabel('scenery-art')?.scale.x).toBe(0.3)

    const lit = { ...frame, dynamic: frame.dynamic === null ? null : { ...frame.dynamic, props: { ...frame.dynamic.props, [hearthId]: 'lit' } } }
    layer.reconcile(lit)
    const nextTick = { ...lit, presentationTick: lit.presentationTick + 1 }
    const inactive = {
      ...nextTick,
      dynamic: nextTick.dynamic === null ? null : { ...nextTick.dynamic, props: { ...nextTick.dynamic.props, [hearthId]: 'unlit' } },
    }
    expect(hasSustainedPropEffectTransition(lit, nextTick)).toBe(true)
    expect(hasSustainedPropEffectTransition(lit, lit)).toBe(false)
    expect(hasSustainedPropEffectTransition(lit, inactive)).toBe(false)
    expect(layer.advance({ ...lit, presentationTick: 4.2 })).toBe(true)
    expect(upper.children.some((child) => child.label === `prop-effect:${hearthId}` && child.visible)).toBe(true)
    expect(emissives.children.some((child) => child.label === `prop-emissive:${hearthId}` && child.visible)).toBe(true)
  })

  it('keeps east-west fallback geometry aligned after the facing container turns', () => {
    const frame = scene()
    const scenery = new Container()
    const props = new Container()
    const layer = createPropLayer(scenery, props, new Container(), new Container(), frame.static)
    const east = frame.static.props.find((item) => item.shape === 'box' && item.facing === 'east')
    if (east === undefined) throw new Error('Fixture has no east-facing box prop.')
    const fallback = node(node(props, `prop:${east.id}`), 'prop-fallback').getLocalBounds()
    expect(fallback.width).toBe(east.rect.height)
    expect(fallback.height).toBe(east.rect.width)
    layer.highlight(east.id)
  })
})