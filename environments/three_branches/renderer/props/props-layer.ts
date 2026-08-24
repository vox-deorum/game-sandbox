import { BlurFilter, Container, Graphics, Sprite, Texture } from 'pixi.js'

import { THREE_BRANCHES_ASSET_CATALOG } from '../assets.js'
import { buildingOccupied } from '../buildings/buildings.js'
import {
  bellStrikerTreatment,
  HEARTHSIDE_STYLE,
  PALETTE,
  propEffectAnchor,
  propVisualScale,
  sceneryVisualScale,
  THREE_BRANCHES_PRESENTATION,
} from '../core/presentation.js'
import type { FrameScene, StaticDrawable, StaticScene } from '../core/types.js'
import {
  bellStrikerRotation,
  emissiveSpec,
  hasPropEffect,
  propEffectFrames,
  propEffectSpec,
} from '../effects/effects.js'
import { CATALOG } from '../ui/overlay.js'
import { frameRectangle } from '../ui/tint.js'
import {
  isFixedFacingPropType,
  isShippedPropType,
  PINE_FRAME_NAMES,
  type PropArtFrame,
  propTreatment,
  sceneryFrame,
} from './props-art.js'

const EFFECT_SCALE = 0.25
const SCENERY_TEXTURE_DENSITY_DIVISOR = 8

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
  destroy(): void
}

interface PropNode {
  item: StaticDrawable
  lowerRoot: Container
  fallback: Graphics
  outline: Sprite
  lower: Sprite
  movingRoot: Container
  moving: Sprite
  effect: Sprite
  effectBlend: Sprite | null
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

/** The world containers a prop draws into, each owned by the world-art stack. */
export interface PropLayerTargets {
  scenery: Container
  /** Texture silhouettes below scenery and props, so their expansion never stains artwork. */
  outlines: Container
  props: Container
  /** Sustained prop effects that belong above characters. */
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
  let destroyed = false
  const outlineTreatment = HEARTHSIDE_STYLE.postEffects.textureOutline
  const outlineFilter = new BlurFilter({
    strength: outlineTreatment.blurStrength,
    quality: 2,
    kernelSize: 5,
  })
  // Leave enough transparent filter area for the Gaussian tail to fade before Pixi clips it.
  outlineFilter.padding = Math.ceil(outlineTreatment.blurStrength * 4)
  const outlineSprites: Sprite[] = []
  const pines = new Container({ label: 'pines' })
  const pineBuildingCutout = new Graphics({ label: 'pine-building-cutout' })
  pines.setMask({ mask: pineBuildingCutout, inverse: true })

  for (const item of scene.props) {
    const node = createPropNode(item, outlineFilter)
    nodes.set(item.id, node)
    layers.outlines.addChild(node.outline)
    outlineSprites.push(node.outline)
    layers.props.addChild(node.lowerRoot)
    layers.effects.addChild(node.effect)
    if (node.effectBlend !== null) layers.effects.addChild(node.effectBlend)
    layers.emissives.addChild(node.emissive)
  }
  for (const item of scene.scenery) {
    const target = item.type === 'pine' ? pines : layers.scenery
    target.addChild(createSceneryNode(item))
    if (item.type === 'crate') {
      const outline = marketCrateOutline(item, cellSize, outlineFilter)
      layers.outlines.addChild(outline)
      outlineSprites.push(outline)
    }
  }
  // Effects are added first, then pines sit over the entire authored village.
  // The inverse mask leaves only occupied building interiors clear.
  layers.effects.addChild(pines, pineBuildingCutout)
  const highlightNode = new Graphics({ label: 'prop-highlight' })
  layers.highlight.addChild(highlightNode)

  const applyState = (node: PropNode, state: string): void => {
    if (node.state === state) return
    node.state = state
    if (art === null) return
    const shipped = isShippedPropType(node.item.type)
    node.fallback.visible = !shipped
    const treatment = shipped ? propTreatment(node.item.type, state, node.item.id) : null
    syncPropRole(node.outline, treatment?.lower ?? null, art)
    syncPropRole(
      node.lower,
      treatment?.lower ?? null,
      art,
    )
    const movingTreatment = treatment?.moving ?? null
    syncPropRole(node.moving, movingTreatment, art)
    node.movingRoot.visible = movingTreatment !== null
  }

  return {
    install(nextArt) {
      preflightArt(nextArt)
      for (const node of nodes.values()) syncArtScale(node)
      art = nextArt
      for (const item of scene.scenery) {
        installScenery(item.type === 'pine' ? pines : layers.scenery, item, nextArt, cellSize)
        if (item.type === 'crate') installMarketCrateOutline(layers.outlines, item, nextArt)
      }
      for (const node of nodes.values()) {
        const state = node.state ?? start(starts, node.item.id)
        node.state = null
        applyState(node, state)
      }
    },
    reconcile(frame) {
      syncPineBuildingCutout(pineBuildingCutout, frame)
      for (const node of nodes.values()) {
        applyState(node, frame.dynamic?.props[node.item.id] ?? start(starts, node.item.id))
      }
    },
    advance(value) {
      if (art === null) return false
      const tick = typeof value === 'number' ? value : value.presentationTick
      let active = false
      for (const node of nodes.values()) {
        node.lowerRoot.rotation = visualFacing(node.item)
        node.outline.rotation = visualFacing(node.item)
        const state = node.state ?? start(starts, node.item.id)
        if (!isShippedPropType(node.item.type)) {
          node.effect.visible = false
          if (node.effectBlend !== null) node.effectBlend.visible = false
          node.emissive.visible = false
          continue
        }
        node.movingRoot.rotation = bellStrikerRotation(state, node.item.id, tick)
        const effect = propEffectSpec(node.item.type, state, node.item.id, tick)
        const emissive = emissiveSpec(node.item.type, state)
        node.effect.visible = effect !== null
        node.emissive.visible = emissive !== null
        // The effect anchor places a generated accent over its centered base artwork. The same
        // anchor also positions the emissive pool below.
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
          syncEffectBlend(node.effectBlend, node.effect, effect, art.effects)
        } else if (node.effectBlend !== null) {
          node.effectBlend.visible = false
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
    destroy() {
      if (destroyed) return
      destroyed = true
      for (const outline of outlineSprites) outline.filters = []
      outlineFilter.blurXFilter.destroy()
      outlineFilter.blurYFilter.destroy()
      outlineFilter.destroy()
    },
  }
}

/** Rebuild the retained inverse mask from semantic, snapped building occupancy. */
function syncPineBuildingCutout(mask: Graphics, frame: FrameScene): void {
  mask.clear()
  for (const building of frame.static.buildings) {
    if (!buildingOccupied(frame, building)) continue
    mask
      .rect(building.rect.x, building.rect.y, building.rect.width, building.rect.height)
      .fill(0xffffff)
  }
}

function createSceneryNode(item: StaticDrawable): Container {
  const root = new Container({ label: `scenery:${item.id}` })
  root.position.set(centerX(item), centerY(item))
  root.addChild(fallback(item, false))
  return root
}

function createPropNode(item: StaticDrawable, outlineFilter: BlurFilter): PropNode {
  const lowerRoot = new Container({ label: `prop-lower:${item.id}` })
  lowerRoot.position.set(centerX(item), centerY(item))
  lowerRoot.rotation = visualFacing(item)
  const fallbackNode = fallback(item, true)
  const artScale = propArtScale(item)
  const outline = sprite(
    `prop-texture-outline:${item.id}`,
    Texture.EMPTY,
    artScale,
  )
  outline.position.set(centerX(item), centerY(item))
  outline.rotation = visualFacing(item)
  outline.tint = HEARTHSIDE_STYLE.palette[HEARTHSIDE_STYLE.postEffects.textureOutline.tint]
  outline.alpha = HEARTHSIDE_STYLE.postEffects.textureOutline.opacity
  outline.filters = [outlineFilter]
  outline.visible = false
  const lower = propSprite('prop-lower-art', Texture.EMPTY, artScale)
  lower.visible = false
  const movingRoot = new Container({ label: `prop-moving:${item.id}` })
  const moving = propSprite('prop-moving-art', Texture.EMPTY, artScale)
  moving.visible = false
  movingRoot.visible = false
  movingRoot.addChild(moving)
  syncMovingArtRegistration(item, movingRoot, moving)
  lowerRoot.addChild(fallbackNode, lower, movingRoot)
  const effect = sprite(`prop-effect:${item.id}`, Texture.EMPTY, EFFECT_SCALE)
  const effectBlend =
    item.type === 'lantern'
      ? sprite(`prop-effect-blend:${item.id}`, Texture.EMPTY, EFFECT_SCALE)
      : null
  const emissive = sprite(`prop-emissive:${item.id}`, Texture.EMPTY, EFFECT_SCALE)
  effect.rotation = visualFacing(item)
  emissive.rotation = visualFacing(item)
  effect.visible = false
  if (effectBlend !== null) effectBlend.visible = false
  emissive.visible = false
  return {
    item,
    lowerRoot,
    fallback: fallbackNode,
    outline,
    lower,
    movingRoot,
    moving,
    effect,
    effectBlend,
    emissive,
    state: null,
  }
}

function installScenery(
  layer: Container,
  item: StaticDrawable,
  art: PropArt,
  cellSize: number,
): void {
  const root = layer.children.find((child) => child.label === `scenery:${item.id}`)
  if (!(root instanceof Container)) return
  const scale = sceneryArtScale(item, cellSize)
  const existing = root.getChildByLabel('scenery-art')
  if (existing instanceof Sprite) {
    existing.texture = texture(art.scenery, sceneryFrame(item.type, item.id))
    existing.scale.set(scale)
    return
  }
  const artNode = sprite(
    'scenery-art',
    texture(art.scenery, sceneryFrame(item.type, item.id)),
    scale,
  )
  artNode.tint = 0xffffff
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

/** Outline the market crate without adding an outline to the pine scenery family. */
function marketCrateOutline(
  item: StaticDrawable,
  cellSize: number,
  outlineFilter: BlurFilter,
): Sprite {
  const treatment = HEARTHSIDE_STYLE.postEffects.textureOutline
  const outline = sprite(
    `market-crate-texture-outline:${item.id}`,
    Texture.EMPTY,
    sceneryArtScale(item, cellSize),
  )
  outline.position.set(centerX(item), centerY(item))
  outline.tint = HEARTHSIDE_STYLE.palette[treatment.tint]
  outline.alpha = treatment.opacity
  outline.filters = [outlineFilter]
  outline.visible = false
  return outline
}

function installMarketCrateOutline(layer: Container, item: StaticDrawable, art: PropArt): void {
  const outline = layer.getChildByLabel(`market-crate-texture-outline:${item.id}`)
  if (!(outline instanceof Sprite)) return
  outline.texture = texture(art.scenery, sceneryFrame(item.type, item.id))
  outline.visible = true
}

function sceneryArtScale(item: StaticDrawable, cellSize: number): number {
  const footprintScale =
    item.shape === 'box'
      ? Math.max(item.rect.width, item.rect.height) / cellSize
      : item.collisionScale
  return (sceneryVisualScale(item.type) * footprintScale) / SCENERY_TEXTURE_DENSITY_DIVISOR
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

function syncArtScale(
  node: Pick<PropNode, 'item' | 'outline' | 'lower' | 'movingRoot' | 'moving'>,
): void {
  const scale = propArtScale(node.item)
  node.outline.scale.set(scale)
  node.lower.scale.set(scale)
  syncMovingArtRegistration(node.item, node.movingRoot, node.moving)
}

function syncPropRole(node: Sprite, treatment: PropArtFrame | null, art: PropArt): void {
  node.visible = treatment !== null
  if (treatment === null) {
    node.texture = Texture.EMPTY
    return
  }
  const frame = propTexture(art, treatment)
  node.texture = frame
  node.anchor.set(0.5)
}

function syncMovingArtRegistration(item: StaticDrawable, root: Container, node: Sprite): void {
  const scale = propArtScale(item)
  node.scale.set(scale)
  if (item.type !== 'bell') {
    root.position.set(0, 0)
    return
  }
  const pivot = bellStrikerTreatment().pivot
  const offsetX = (pivot.x - 384 / 2) * scale
  const offsetY = (pivot.y - 256 / 2) * scale
  root.position.set(offsetX, offsetY)
  node.position.set(-offsetX, -offsetY)
}

function syncEffectBlend(
  blendNode: Sprite | null,
  primary: Sprite,
  effect: NonNullable<ReturnType<typeof propEffectSpec>>,
  effects: Readonly<Record<string, Texture>>,
): void {
  if (blendNode === null || effect.nextFrame === undefined || effect.blend === undefined) return
  blendNode.visible = true
  blendNode.texture = texture(effects, effect.nextFrame)
  blendNode.tint = primary.tint
  blendNode.alpha = effect.alpha * effect.blend
  blendNode.scale.copyFrom(primary.scale)
  blendNode.position.copyFrom(primary.position)
  blendNode.rotation = primary.rotation
  primary.alpha = effect.alpha * (1 - effect.blend)
}

function centerX(item: StaticDrawable): number {
  return item.rect.x + item.rect.width / 2
}
function centerY(item: StaticDrawable): number {
  return item.rect.y + item.rect.height / 2
}
function propArtScale(item: StaticDrawable): number {
  return propVisualScale(item.type)
}

export function visualFacing(item: StaticDrawable): number {
  if (isFixedFacingPropType(item.type)) return 0
  // The stall texture's front reads the opposite way from the recorded facing, so its sprite is
  // drawn half a turn round from where it stands.
  return facing(item.facing) + (item.type === 'stall' ? Math.PI : 0)
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

function propTexture(art: PropArt, treatment: PropArtFrame): Texture {
  return texture(art[treatment.page], treatment.frame, `${treatment.page}.${treatment.frame}`)
}

function texture(
  frames: Readonly<Record<string, Texture>>,
  name: string,
  displayName: string = name,
): Texture {
  const value = frames[name]
  if (value === undefined) throw new Error(`Three Branches prop frame is missing: ${displayName}`)
  return value
}
function atlasEntry(name: 'props' | 'scenery' | 'effects') {
  const atlas = THREE_BRANCHES_ASSET_CATALOG.find((item) => item.name === name)
  if (atlas === undefined || 'layers' in atlas) {
    throw new Error(`Three Branches ${name} atlas is missing.`)
  }
  return atlas
}
function framesFor(
  name: 'props' | 'scenery' | 'effects',
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
  for (const scenery of CATALOG.scenery) {
    if (scenery.token === 'pine') {
      for (const frame of PINE_FRAME_NAMES) texture(art.scenery, frame)
    } else texture(art.scenery, sceneryFrame(scenery.token, 'preflight'))
  }
  for (const prop of CATALOG.props) {
    if (!isShippedPropType(prop.token)) continue
    const ids = prop.token === 'stall' ? ['stall_0', 'stall_1', 'stall_2'] : ['preflight']
    for (const state of prop.states) {
      for (const id of ids) {
        const treatment = propTreatment(prop.token, state, id)
        propTexture(art, treatment.lower)
        if (treatment.moving !== undefined) propTexture(art, treatment.moving)
      }
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
