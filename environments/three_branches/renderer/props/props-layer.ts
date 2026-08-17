import { Container, Graphics, Sprite, Texture } from 'pixi.js'

import { THREE_BRANCHES_ASSET_CATALOG } from '../assets.js'
import {
  HEARTHSIDE_STYLE,
  PALETTE,
  propEffectAnchor,
  propMonumentTreatment,
  propVisualScale,
  sceneryVisualScale,
  THREE_BRANCHES_PRESENTATION,
} from '../core/presentation.js'
import type { FrameScene, StaticDrawable, StaticScene } from '../core/types.js'
import {
  emissiveSpec,
  hasPropEffect,
  propEffectFrames,
  propEffectSpec,
} from '../effects/effects.js'
import { CATALOG } from '../ui/overlay.js'
import { frameRectangle } from '../ui/tint.js'
import { isShippedPropType, propFoundationFrame, propTreatment, sceneryFrame } from './props-art.js'

const EFFECT_SCALE = 0.25

/** The effects-atlas cell the contact shadow is drawn from, so its scale reaches a real footprint. */
const SHADOW_SOURCE = shadowSourceSize()

/** Pages that become artwork for props, scenery, and their effects. */
export interface PropAtlasTextures {
  props: Texture
  monuments: Texture
  scenery: Texture
  effects: Texture
}

/** Named frame views shared by retained scenery, prop, and accent nodes. */
export interface PropArt {
  props: Readonly<Record<string, Texture>>
  monuments: Readonly<Record<string, Texture>>
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
  foundation: Sprite
  still: Sprite
  effect: Sprite
  emissive: Sprite
  state: string | null
}

/** Slice prop, scenery, and effect atlas pages without changing source artwork. */
export function createPropArt(atlases: PropAtlasTextures): PropArt {
  return {
    props: framesFor('props', atlases.props),
    monuments: framesFor('monuments', atlases.monuments),
    scenery: framesFor('scenery', atlases.scenery),
    effects: framesFor('effects', atlases.effects),
  }
}

/** The world containers a prop draws into, each owned by the world-art stack. */
export interface PropLayerTargets {
  scenery: Container
  /** Contact shadows, in world space below every prop so one prop's shadow never covers another. */
  shadows: Container
  props: Container
  /** Monument uppers and sustained effects that belong above characters. */
  effects: Container
  emissives: Container
  /** The interaction highlight, drawn after the world grades so hovering never shifts colour. */
  highlight: Container
}

/** Build retained prop stills and reconcile their recorded state by stable prop id. */
export function createPropLayer(layers: PropLayerTargets, scene: StaticScene): PropLayer {
  const cellSize = THREE_BRANCHES_PRESENTATION.unitsPerMetre * scene.village.size.cellSize
  const starts = new Map(
    scene.props.map((item) => {
      const start = CATALOG.props.find((kind) => kind.token === item.type)?.start
      if (start === undefined) throw new Error(`Unknown prop type ${item.type}.`)
      return [item.id, start] as const
    }),
  )
  const nodes = new Map<string, PropNode>()
  let art: PropArt | null = null

  for (const item of scene.scenery) layers.scenery.addChild(createSceneryNode(item))
  for (const item of scene.props) {
    const node = createPropNode(item, cellSize)
    nodes.set(item.id, node)
    layers.shadows.addChild(node.shadow)
    if (isFixedMonument(item)) {
      // A monument's civic upper reads above characters, while its plinth stays with the props.
      layers.effects.addChild(node.root)
      node.foundation.position.set(centerX(item), centerY(item))
      layers.props.addChild(node.foundation)
    } else layers.props.addChild(node.root)
    layers.effects.addChild(node.effect)
    layers.emissives.addChild(node.emissive)
  }
  const highlightNode = new Graphics({ label: 'prop-highlight' })
  layers.highlight.addChild(highlightNode)

  const applyState = (node: PropNode, state: string): void => {
    if (node.state === state) return
    node.state = state
    if (art === null) return
    const shipped = isShippedPropType(node.item.type)
    node.fallback.visible = !shipped
    node.shadow.visible = shipped
    node.shadow.texture = shipped ? texture(art.effects, 'characterShadow') : Texture.EMPTY
    const foundationFrame = propFoundationFrame(node.item.type)
    node.foundation.visible = shipped && foundationFrame !== null
    node.foundation.texture =
      foundationFrame === null
        ? Texture.EMPTY
        : texture(propFrames(art, node.item.type), foundationFrame)
    node.still.visible = shipped
    node.still.texture = shipped
      ? texture(propFrames(art, node.item.type), propTreatment(node.item.type, state).frame)
      : Texture.EMPTY
    syncPropSprite(node.still, node.item, 'still')
    if (foundationFrame !== null) syncPropSprite(node.foundation, node.item, 'foundation')
  }

  return {
    install(nextArt) {
      preflightArt(nextArt)
      for (const node of nodes.values()) syncArtScale(node)
      art = nextArt
      for (const item of scene.scenery) installScenery(layers.scenery, item, nextArt)
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
        node.root.rotation = visualFacing(node.item)
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
        // The effect anchor is where a prop's generated accent sits on its own artwork. The same
        // anchor also positions the emissive pool below, so a prop that has both (lantern today)
        // keeps its flicker and its glow glued to the same point instead of at the footprint's
        // center. Adding an anchor to another emissive prop (hearth, frame) deliberately moves that
        // pool too.
        const propScale = propVisualScale(node.item.type)
        const anchor = propEffectAnchor(node.item.type)
        if (effect !== null) {
          active = true
          node.effect.texture = texture(art.effects, effect.frame)
          node.effect.tint = HEARTHSIDE_STYLE.palette[effect.tint]
          node.effect.alpha = effect.alpha
          node.effect.scale.set(EFFECT_SCALE * effect.scale)
          node.effect.position.set(
            centerX(node.item) + anchor.x * propScale + effect.offsetX,
            centerY(node.item) + anchor.y * propScale + effect.offsetY,
          )
          node.effect.rotation = visualFacing(node.item) + effect.rotation
        }
        if (emissive !== null) {
          node.emissive.texture = texture(art.effects, emissive.frame)
          node.emissive.tint = HEARTHSIDE_STYLE.palette[emissive.tint]
          node.emissive.alpha = emissive.alpha
          node.emissive.scale.set(EFFECT_SCALE * emissive.scale)
          node.emissive.position.set(
            centerX(node.item) + anchor.x * propScale,
            centerY(node.item) + anchor.y * propScale,
          )
          node.emissive.rotation = visualFacing(node.item)
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
        highlightNode
          .circle(
            centerX(item),
            centerY(item),
            (Math.min(item.rect.width, item.rect.height) / 2) * item.collisionScale + 2,
          )
          .stroke(stroke)
      } else {
        highlightNode
          .rect(item.rect.x - 2, item.rect.y - 2, item.rect.width + 4, item.rect.height + 4)
          .stroke(stroke)
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

function createPropNode(item: StaticDrawable, cellSize: number): PropNode {
  const root = new Container({ label: `prop:${item.id}` })
  root.position.set(centerX(item), centerY(item))
  root.rotation = visualFacing(item)
  const shadow = propShadow(item, cellSize)
  const fallbackNode = fallback(item, true)
  const artScale = propArtScale(item)
  const foundation = propSprite('prop-foundation', Texture.EMPTY, artScale)
  foundation.visible = false
  const still = propSprite('prop-still', Texture.EMPTY, artScale)
  root.addChild(fallbackNode, still)
  const effect = sprite(`prop-effect:${item.id}`, Texture.EMPTY, EFFECT_SCALE)
  const emissive = sprite(`prop-emissive:${item.id}`, Texture.EMPTY, EFFECT_SCALE)
  effect.rotation = visualFacing(item)
  emissive.rotation = visualFacing(item)
  effect.visible = false
  emissive.visible = false
  return {
    item,
    root,
    fallback: fallbackNode,
    shadow,
    foundation,
    still,
    effect,
    emissive,
    state: null,
  }
}

function installScenery(layer: Container, item: StaticDrawable, art: PropArt): void {
  const root = layer.children.find((child) => child.label === `scenery:${item.id}`)
  if (!(root instanceof Container)) return
  const scale = sceneryVisualScale(item.type) * item.collisionScale
  const existing = root.getChildByLabel('scenery-art')
  if (existing instanceof Sprite) {
    existing.scale.set(scale)
    return
  }
  if (existing !== null) return
  const artNode = sprite(
    'scenery-art',
    texture(art.scenery, sceneryFrame(item.type, item.id)),
    scale,
  )
  artNode.tint = HEARTHSIDE_STYLE.palette[item.type === 'pine' ? 'pine' : 'timber']
  root.addChild(artNode)
  const fallbackNode = root.getChildByLabel('scenery-fallback')
  if (fallbackNode !== null) fallbackNode.visible = false
}

function fallback(item: StaticDrawable, interactive: boolean): Graphics {
  const node = new Graphics({ label: interactive ? 'prop-fallback' : 'scenery-fallback' })
  const color = interactive ? PALETTE.prop : PALETTE.scenery
  if (item.shape === 'circle')
    node.circle(0, 0, Math.min(item.rect.width, item.rect.height) / 2).fill(color)
  else {
    const { width, height } = localFootprint(item)
    node.rect(-width / 2, -height / 2, width, height).fill(color)
  }
  return node
}

/**
 * Ground one prop in world space. The sprite carries the facing rotation itself and the southward
 * offset is added to its world position afterwards, so the offset stays south whichever way the
 * prop turns. Sizing keeps reading the unrotated footprint, which preserves the east and west
 * behaviour the rotating prop root used to give for free.
 */
function propShadow(item: StaticDrawable, cellSize: number): Sprite {
  const treatment = HEARTHSIDE_STYLE.postEffects.propContactShadow
  const shadow = sprite(`prop-contact-shadow:${item.id}`, Texture.EMPTY, 1)
  const { width, height } = localFootprint(item)
  const collisionScale = isFixedMonument(item) ? item.collisionScale : 1
  shadow.scale.set(
    (width * collisionScale * treatment.widthFactor) / SHADOW_SOURCE.width,
    (height * collisionScale * treatment.heightFactor) / SHADOW_SOURCE.height,
  )
  shadow.rotation = visualFacing(item)
  shadow.position.set(centerX(item), centerY(item) + treatment.offsetYCells * cellSize)
  shadow.tint = HEARTHSIDE_STYLE.palette[treatment.tint]
  shadow.alpha = treatment.opacity
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

function propSprite(label: string, frame: Texture, scale: number): Sprite {
  return sprite(label, frame, scale)
}

function syncArtScale(node: Pick<PropNode, 'item' | 'foundation' | 'still'>): void {
  const scale = propArtScale(node.item)
  node.foundation.scale.set(scale)
  node.still.scale.set(scale)
}

function syncPropSprite(node: Sprite, item: StaticDrawable, role: 'still' | 'foundation'): void {
  const monument = propMonumentTreatment(item.type)
  if (monument === null) {
    node.anchor.set(0.5)
    return
  }
  const anchor = monument.sourceAnchorByRole[role]
  if (anchor === undefined) {
    throw new Error(`Three Branches monument source anchor is missing: ${item.type}.${role}`)
  }
  node.anchor.set(anchor.x / node.texture.width, anchor.y / node.texture.height)
}

function centerX(item: StaticDrawable): number {
  return item.rect.x + item.rect.width / 2
}
function centerY(item: StaticDrawable): number {
  return item.rect.y + item.rect.height / 2
}
function propArtScale(item: StaticDrawable): number {
  const monument = propMonumentTreatment(item.type)
  return propVisualScale(item.type) / (monument?.textureDensityDivisor ?? 1)
}
function propFrames(art: PropArt, type: string): Readonly<Record<string, Texture>> {
  return isFixedMonumentType(type) ? art.monuments : art.props
}
function isFixedMonument(item: StaticDrawable): boolean {
  return isFixedMonumentType(item.type)
}
function isFixedMonumentType(type: string): boolean {
  return propMonumentTreatment(type) !== null
}
function visualFacing(item: StaticDrawable): number {
  return isFixedMonument(item) ? 0 : facing(item.facing)
}
function facing(value: string | undefined): number {
  return (
    ({ north: 0, east: Math.PI / 2, south: Math.PI, west: -Math.PI / 2 } as Record<string, number>)[
      value ?? 'north'
    ] ?? 0
  )
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
function atlasEntry(name: 'props' | 'monuments' | 'scenery' | 'effects') {
  const atlas = THREE_BRANCHES_ASSET_CATALOG.find((item) => item.name === name)
  if (atlas === undefined || 'layers' in atlas) {
    throw new Error(`Three Branches ${name} atlas is missing.`)
  }
  return atlas
}
function shadowSourceSize(): { width: number; height: number } {
  const atlas = atlasEntry('effects')
  return { width: atlas.frames.width, height: atlas.frames.height }
}
function framesFor(
  name: 'props' | 'monuments' | 'scenery' | 'effects',
  atlasTexture: Texture,
): Readonly<Record<string, Texture>> {
  const atlas = atlasEntry(name)
  return Object.fromEntries(
    atlas.frames.names.map((frame) => [
      frame,
      new Texture({ source: atlasTexture.source, frame: frameRectangle(atlas.frames, frame) }),
    ]),
  )
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
    const foundationFrame = propFoundationFrame(prop.token)
    if (foundationFrame !== null) texture(propFrames(art, prop.token), foundationFrame)
    for (const state of prop.states) {
      texture(propFrames(art, prop.token), propTreatment(prop.token, state).frame)
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
