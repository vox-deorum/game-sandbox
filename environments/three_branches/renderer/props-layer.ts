import { Container, Graphics, Sprite, Texture } from 'pixi.js'

import { THREE_BRANCHES_ASSET_CATALOG } from './assets.js'
import { emissiveSpec, hasPropEffect, propEffectFrames, propEffectSpec } from './effects.js'
import { CATALOG } from './overlay.js'
import { HEARTHSIDE_STYLE, PALETTE } from './presentation.js'
import { isShippedPropType, propTreatment, sceneryFrame } from './props-art.js'
import { frameRectangle } from './tint.js'

import type { FrameScene, StaticDrawable, StaticScene } from './types.js'

const PROP_SCALE = 0.14
const SCENERY_SCALE = 0.25
const EFFECT_SCALE = 0.25

/** Pages that become artwork for props, scenery, and their effects. */
export interface PropAtlasTextures {
  props: Texture
  scenery: Texture
  effects: Texture
}

/** Named frame views shared by retained scenery, prop, and accent nodes. */
export interface PropArt {
  props: Readonly<Record<string, Texture>>
  scenery: Readonly<Record<string, Texture>>
  effects: Readonly<Record<string, Texture>>
}

/** Operations exposed by the retained prop display layer. */
export interface PropLayer {
  install(art: PropArt): void
  reconcile(scene: FrameScene): void
  advance(value: number | FrameScene): boolean
  highlight(propId: string | null): void
}

interface PropNode {
  item: StaticDrawable
  root: Container
  fallback: Graphics
  shadow: Sprite
  still: Sprite
  effect: Sprite
  emissive: Sprite
  state: string | null
}

/** Slice prop, scenery, and effect atlas pages without changing source artwork. */
export function createPropArt(atlases: PropAtlasTextures): PropArt {
  return {
    props: framesFor('props', atlases.props),
    scenery: framesFor('scenery', atlases.scenery),
    effects: framesFor('effects', atlases.effects),
  }
}

/** Build retained prop stills and reconcile their recorded state by stable prop id. */
export function createPropLayer(
  sceneryLayer: Container,
  propLayer: Container,
  upperLayer: Container,
  emissiveLayer: Container,
  scene: StaticScene,
): PropLayer {
  const starts = new Map(
    scene.props.map((item) => {
      const start = CATALOG.props.find((kind) => kind.token === item.type)?.start
      if (start === undefined) throw new Error(`Unknown prop type ${item.type}.`)
      return [item.id, start] as const
    }),
  )
  const nodes = new Map<string, PropNode>()
  let art: PropArt | null = null

  for (const item of scene.scenery) sceneryLayer.addChild(createSceneryNode(item))
  for (const item of scene.props) {
    const node = createPropNode(item)
    nodes.set(item.id, node)
    propLayer.addChild(node.root)
    upperLayer.addChild(node.effect)
    emissiveLayer.addChild(node.emissive)
  }
  const highlightNode = new Graphics({ label: 'prop-highlight' })
  propLayer.addChild(highlightNode)

  const applyState = (node: PropNode, state: string): void => {
    if (node.state === state) return
    node.state = state
    if (art === null) return
    const shipped = isShippedPropType(node.item.type)
    node.fallback.visible = !shipped
    node.shadow.visible = shipped
    node.shadow.texture = shipped ? texture(art.effects, 'characterShadow') : Texture.EMPTY
    node.still.visible = shipped
    node.still.texture = shipped ? texture(art.props, propTreatment(node.item.type, state).frame) : Texture.EMPTY
  }

  return {
    install(nextArt) {
      preflightArt(nextArt)
      art = nextArt
      for (const item of scene.scenery) installScenery(sceneryLayer, item, nextArt)
      for (const node of nodes.values()) {
        const state = node.state ?? start(starts, node.item.id)
        node.state = null
        applyState(node, state)
      }
    },
    reconcile(frame) {
      for (const node of nodes.values()) {
        applyState(node, frame.dynamic?.props[node.item.id] ?? start(starts, node.item.id))
      }
    },
    advance(value) {
      if (art === null) return false
      const tick = typeof value === 'number' ? value : value.presentationTick
      let active = false
      for (const node of nodes.values()) {
        node.root.rotation = facing(node.item.facing)
        if (!isShippedPropType(node.item.type)) {
          node.effect.visible = false
          node.emissive.visible = false
          continue
        }
        const state = node.state ?? start(starts, node.item.id)
        const effect = propEffectSpec(node.item.type, state, node.item.id, tick)
        const emissive = emissiveSpec(node.item.type, state)
        node.effect.visible = effect !== null
        node.emissive.visible = emissive !== null
        if (effect !== null) {
          active = true
          node.effect.texture = texture(art.effects, effect.frame)
          node.effect.tint = HEARTHSIDE_STYLE.palette[effect.tint]
          node.effect.alpha = effect.alpha
          node.effect.scale.set(EFFECT_SCALE * effect.scale)
          node.effect.position.set(centerX(node.item), centerY(node.item) + effect.offsetY)
          node.effect.rotation = facing(node.item.facing) + effect.rotation
        }
        if (emissive !== null) {
          node.emissive.texture = texture(art.effects, emissive.frame)
          node.emissive.tint = HEARTHSIDE_STYLE.palette[emissive.tint]
          node.emissive.alpha = emissive.alpha
          node.emissive.scale.set(EFFECT_SCALE * emissive.scale)
          node.emissive.position.set(centerX(node.item), centerY(node.item))
          node.emissive.rotation = facing(node.item.facing)
        }
      }
      return active
    },
    highlight(propId) {
      highlightNode.clear()
      if (propId === null) return
      const item = scene.props.find((prop) => prop.id === propId)
      if (item === undefined) return
      const stroke = { color: HEARTHSIDE_STYLE.palette.gilt, width: 2 }
      if (item.shape === 'circle') {
        highlightNode.circle(centerX(item), centerY(item), Math.min(item.rect.width, item.rect.height) / 2 + 2).stroke(stroke)
      } else {
        highlightNode.rect(item.rect.x - 2, item.rect.y - 2, item.rect.width + 4, item.rect.height + 4).stroke(stroke)
      }
    },
  }
}

function createSceneryNode(item: StaticDrawable): Container {
  const root = new Container({ label: `scenery:${item.id}` })
  root.position.set(centerX(item), centerY(item))
  root.addChild(fallback(item, false))
  return root
}

function createPropNode(item: StaticDrawable): PropNode {
  const root = new Container({ label: `prop:${item.id}` })
  root.position.set(centerX(item), centerY(item))
  root.rotation = facing(item.facing)
  const shadow = propShadow(item)
  const fallbackNode = fallback(item, true)
  const still = propSprite('prop-still', Texture.EMPTY)
  root.addChild(shadow, fallbackNode, still)
  const effect = sprite(`prop-effect:${item.id}`, Texture.EMPTY, EFFECT_SCALE)
  const emissive = sprite(`prop-emissive:${item.id}`, Texture.EMPTY, EFFECT_SCALE)
  effect.visible = false
  emissive.visible = false
  return { item, root, fallback: fallbackNode, shadow, still, effect, emissive, state: null }
}

function installScenery(layer: Container, item: StaticDrawable, art: PropArt): void {
  const root = layer.children.find((child) => child.label === `scenery:${item.id}`)
  if (!(root instanceof Container) || root.getChildByLabel('scenery-art') !== null) return
  const artNode = sprite('scenery-art', texture(art.scenery, sceneryFrame(item.type, item.id)), SCENERY_SCALE)
  artNode.tint = HEARTHSIDE_STYLE.palette[item.type === 'pine' ? 'pine' : 'timber']
  root.addChild(artNode)
  const fallbackNode = root.getChildByLabel('scenery-fallback')
  if (fallbackNode !== null) fallbackNode.visible = false
}

function fallback(item: StaticDrawable, interactive: boolean): Graphics {
  const node = new Graphics({ label: interactive ? 'prop-fallback' : 'scenery-fallback' })
  const color = interactive ? PALETTE.prop : PALETTE.scenery
  if (item.shape === 'circle') node.circle(0, 0, Math.min(item.rect.width, item.rect.height) / 2).fill(color)
  else {
    const { width, height } = localFootprint(item)
    node.rect(-width / 2, -height / 2, width, height).fill(color)
  }
  return node
}

function propShadow(item: StaticDrawable): Sprite {
  const shadow = sprite('prop-contact-shadow', Texture.EMPTY, 1)
  const { width, height } = localFootprint(item)
  shadow.scale.set((width * 0.9) / 192, (height * 0.6) / 128)
  shadow.tint = HEARTHSIDE_STYLE.palette.backdrop
  shadow.alpha = 0.25
  shadow.visible = false
  return shadow
}

function localFootprint(item: StaticDrawable): { width: number; height: number } {
  const turned = item.facing === 'east' || item.facing === 'west'
  return {
    width: turned ? item.rect.height : item.rect.width,
    height: turned ? item.rect.width : item.rect.height,
  }
}
function sprite(label: string, frame: Texture, scale: number): Sprite {
  const node = new Sprite({ label, texture: frame })
  node.anchor.set(0.5)
  node.scale.set(scale)
  return node
}

function propSprite(label: string, frame: Texture): Sprite {
  return sprite(label, frame, PROP_SCALE)
}

function centerX(item: StaticDrawable): number { return item.rect.x + item.rect.width / 2 }
function centerY(item: StaticDrawable): number { return item.rect.y + item.rect.height / 2 }
function facing(value: string | undefined): number {
  return ({ north: 0, east: Math.PI / 2, south: Math.PI, west: -Math.PI / 2 } as Record<string, number>)[value ?? 'north'] ?? 0
}
function start(starts: ReadonlyMap<string, string>, id: string): string {
  const value = starts.get(id)
  if (value === undefined) throw new Error(`Three Branches prop start state is missing: ${id}`)
  return value
}
function texture(frames: Readonly<Record<string, Texture>>, name: string): Texture {
  const value = frames[name]
  if (value === undefined) throw new Error(`Three Branches prop frame is missing: ${name}`)
  return value
}
function framesFor(name: 'props' | 'scenery' | 'effects', atlasTexture: Texture): Readonly<Record<string, Texture>> {
  const atlas = THREE_BRANCHES_ASSET_CATALOG.find((item) => item.name === name)
  if (atlas === undefined || 'layers' in atlas) throw new Error(`Three Branches ${name} atlas is missing.`)
  return Object.fromEntries(atlas.frames.names.map((frame) => [frame, new Texture({ source: atlasTexture.source, frame: frameRectangle(atlas.frames, frame) })]))
}
function preflightArt(art: PropArt): void {
  texture(art.effects, 'characterShadow')
  for (const scenery of CATALOG.scenery) {
    if (scenery.token === 'pine') {
      texture(art.scenery, 'pineA')
      texture(art.scenery, 'pineB')
      texture(art.scenery, 'pineC')
    } else texture(art.scenery, sceneryFrame(scenery.token, 'preflight'))
  }
  for (const prop of CATALOG.props) {
    if (!isShippedPropType(prop.token)) continue
    for (const state of prop.states) {
      texture(art.props, propTreatment(prop.token, state).frame)
      for (const frame of propEffectFrames(prop.token, state)) texture(art.effects, frame)
      const emissive = emissiveSpec(prop.token, state)
      if (emissive !== null) texture(art.effects, emissive.frame)
    }
  }
}

/** Whether a new recorded tick needs a finite fractional transition for a sustained prop effect. */
export function hasSustainedPropEffectTransition(from: FrameScene, to: FrameScene): boolean {
  if (from.presentationTick === to.presentationTick) return false
  return to.static.props.some((prop) => {
    if (!isShippedPropType(prop.type)) return false
    const state = to.dynamic?.props[prop.id] ?? startState(prop.type)
    return hasPropEffect(prop.type, state)
  })
}

function startState(type: string): string {
  const state = CATALOG.props.find((prop) => prop.token === type)?.start
  if (state === undefined) throw new Error(`Three Branches prop start state is missing: ${type}`)
  return state
}
