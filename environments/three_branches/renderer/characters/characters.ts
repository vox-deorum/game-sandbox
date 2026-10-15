import { degreesToRadians } from '@renderers/base/math.js'
import { Container, Graphics, Sprite, Texture } from 'pixi.js'
import { THREE_BRANCHES_ASSET_CATALOG } from '../assets.js'
import type { CharacterCastSet } from '../core/presentation.js'
import { HEARTHSIDE_STYLE, PALETTE, THREE_BRANCHES_PRESENTATION } from '../core/presentation.js'
import type { CharacterDrawable, FrameScene } from '../core/types.js'
import type { DayShadow } from '../effects/post-effects.js'
import { type FrameGrid, frameRectangle } from '../ui/tint.js'
import { characterGait, characterRotation, characterStyle } from './characters-art.js'

const CHARACTER_SCALE = (THREE_BRANCHES_PRESENTATION.unitsPerMetre / 128) * 0.85
const CHARACTER_FRAME_SIZE = 192
/** The soft ellipse inside the shadow frame: its centre and full extent in pixels. */
const SHADOW_ELLIPSE = { x: 95.5, y: 73, width: 69, height: 36 }
const SHADOW_FRAME = { width: 192, height: 128 }
/** Shadow width across the sun direction, as a share of the body diameter. */
const SHADOW_BREADTH = 0.85

/** Loaded pages needed to assemble the retained character art. */
export interface CharacterAtlasTextures {
  characters: Texture
  effects: Texture
}

interface CharacterSetArt {
  base: Texture
  leftArm: Texture
  rightArm: Texture
}

/** Named atlas views shared by every retained character node. */
export interface CharacterArt {
  sets: Readonly<Record<string, CharacterSetArt>>
  shadow: Texture
  directionMark: Texture
}

/** Operations exposed by the retained character display layer. */
export interface CharacterLayer {
  /** Reconcile retained nodes toward one pure frame, its day shadow, and camera readability. */
  reconcile(scene: FrameScene, zoom: number, fittedZoom: number, shadow: DayShadow): void
  /** Replace provisional marks with the loaded Hearthside sprite assembly. */
  install(art: CharacterArt): void
}

interface CharacterNode {
  root: Container
  fallback: Graphics
  farMark: Graphics
  shadow: Sprite | null
  rotor: Container | null
  gait: Container | null
  base: Sprite | null
  leftArm: Sprite | null
  rightArm: Sprite | null
  directionMark: Sprite | null
}

/** Slice the full-color character page and two shared effect frames without changing their sources. */
export function createCharacterArt(atlases: CharacterAtlasTextures): CharacterArt {
  const manifest = THREE_BRANCHES_ASSET_CATALOG.find((item) => item.name === 'characters')
  if (manifest === undefined || 'layers' in manifest) {
    throw new Error('Three Branches character atlas is missing.')
  }
  const effects = THREE_BRANCHES_ASSET_CATALOG.find((item) => item.name === 'effects')
  if (effects === undefined || 'layers' in effects) {
    throw new Error('Three Branches effects atlas is missing.')
  }
  const frames = textureViews(atlases.characters, manifest.frames)
  const effectFrames = textureViews(atlases.effects, effects.frames)
  const sets = [
    HEARTHSIDE_STYLE.characters.cast.visitor,
    ...HEARTHSIDE_STYLE.characters.cast.villagers,
  ]
  return {
    sets: Object.fromEntries(
      sets.map((set) => [
        set.id,
        {
          base: requiredTexture(frames, set.base),
          leftArm: requiredTexture(frames, set.leftArm.frame),
          rightArm: requiredTexture(frames, set.rightArm.frame),
        },
      ]),
    ),
    shadow: requiredTexture(effectFrames, 'characterShadow'),
    directionMark: requiredTexture(effectFrames, 'directionMark'),
  }
}

/** Reconcile characters by stable id so arbitrary replay seeks never depend on arrival order. */
export function createCharacterLayer(layer: Container): CharacterLayer {
  const nodes = new Map<string, CharacterNode>()
  let art: CharacterArt | null = null

  const nodeFor = (id: string): CharacterNode => {
    let node = nodes.get(id)
    if (node !== undefined) return node
    node = createNode(id)
    nodes.set(id, node)
    layer.addChild(node.root)
    if (art !== null) installNodeArt(node, art)
    return node
  }

  return {
    reconcile(scene, zoom, fittedZoom, shadow) {
      const active = new Set(scene.characters.map((character) => character.id))
      for (const [id, node] of nodes) {
        if (!active.has(id)) {
          node.root.destroy({ children: true })
          nodes.delete(id)
        }
      }
      const cellUnits =
        THREE_BRANCHES_PRESENTATION.unitsPerMetre * scene.static.village.size.cellSize
      for (const character of scene.characters) {
        const node = nodeFor(character.id)
        drawCharacter(node, character, art, zoom, fittedZoom)
        if (node.shadow !== null) castShadow(node.shadow, character.radius, shadow, cellUnits)
      }
    },
    install(nextArt) {
      art = nextArt
      for (const node of nodes.values()) installNodeArt(node, nextArt)
    },
  }
}

function createNode(id: string): CharacterNode {
  const root = new Container({ label: `character:${id}` })
  const fallback = new Graphics({ label: 'character-fallback' })
  const farMark = new Graphics({ label: 'character-far-mark' })
  root.addChild(fallback, farMark)
  return {
    root,
    fallback,
    farMark,
    shadow: null,
    rotor: null,
    gait: null,
    base: null,
    leftArm: null,
    rightArm: null,
    directionMark: null,
  }
}

function installNodeArt(node: CharacterNode, art: CharacterArt): void {
  if (node.rotor !== null || node.shadow !== null) return
  const shadow = characterSprite('character-shadow', art.shadow)
  shadow.tint = HEARTHSIDE_STYLE.palette.backdrop
  shadow.anchor.set(SHADOW_ELLIPSE.x / SHADOW_FRAME.width, SHADOW_ELLIPSE.y / SHADOW_FRAME.height)
  const rotor = new Container({ label: 'character-rotor' })
  const gait = new Container({ label: 'character-gait' })
  const directionMark = characterSprite('character-direction-mark', art.directionMark)
  const visitor = requiredSet(art.sets, HEARTHSIDE_STYLE.characters.cast.visitor.id)
  const base = characterSprite('character-base', visitor.base)
  const leftArm = characterSprite('character-left-arm', visitor.leftArm)
  const rightArm = characterSprite('character-right-arm', visitor.rightArm)
  directionMark.tint = HEARTHSIDE_STYLE.palette.ink
  gait.addChild(leftArm, rightArm, base)
  rotor.addChild(directionMark, gait)
  node.root.addChildAt(shadow, 0)
  node.root.addChildAt(rotor, 1)
  node.shadow = shadow
  node.rotor = rotor
  node.gait = gait
  node.base = base
  node.leftArm = leftArm
  node.rightArm = rightArm
  node.directionMark = directionMark
}

function characterSprite(label: string, texture: Texture): Sprite {
  const sprite = new Sprite({ label, texture })
  sprite.anchor.set(0.5)
  sprite.scale.set(CHARACTER_SCALE)
  return sprite
}

function drawCharacter(
  node: CharacterNode,
  character: CharacterDrawable,
  art: CharacterArt | null,
  zoom: number,
  fittedZoom: number,
): void {
  node.root.position.set(character.point.x, character.point.y)
  const rotation = characterRotation(character.heading)
  if (art === null) {
    node.fallback.visible = true
    node.farMark.visible = false
    drawFallback(node.fallback, character, rotation)
    return
  }

  node.fallback.visible = false
  const style = characterStyle(character.id)
  const set = requiredSet(art.sets, style.set.id)
  const farView = zoom < fittedZoom * THREE_BRANCHES_PRESENTATION.farMarkZoomFactor
  node.farMark.visible = farView
  drawFarMark(node.farMark, character.radius, style.farMarkTint, rotation)
  const shadow = requiredPart(node.shadow, 'shadow')
  const rotor = requiredPart(node.rotor, 'rotor')
  shadow.visible = !farView
  rotor.visible = !farView
  rotor.rotation = rotation
  if (farView) return

  const base = requiredPart(node.base, 'base')
  const leftArm = requiredPart(node.leftArm, 'left arm')
  const rightArm = requiredPart(node.rightArm, 'right arm')
  const gaitContainer = requiredPart(node.gait, 'gait')
  base.texture = set.base
  leftArm.texture = set.leftArm
  rightArm.texture = set.rightArm
  const gait = characterGait(character.walkDistance, character.walkBlend)
  registerArm(leftArm, style.set.leftArm, gait.leftArm.travel)
  registerArm(rightArm, style.set.rightArm, gait.rightArm.travel)
  leftArm.rotation = gait.leftArm.rotation
  rightArm.rotation = gait.rightArm.rotation
  gaitContainer.rotation = gait.body.rotation
  gaitContainer.position.set(0, gait.body.bob * CHARACTER_SCALE)
}

/**
 * Lay the drop shadow along the sun: it starts under the body and reaches `length` cells further
 * in the shadow direction, so a low sun draws a long, faint shadow and midday a tight contact one.
 */
function castShadow(sprite: Sprite, radius: number, shadow: DayShadow, cellUnits: number): void {
  const angle = degreesToRadians(shadow.angleDegrees)
  const reach = shadow.length * cellUnits
  sprite.rotation = angle
  sprite.position.set((Math.cos(angle) * reach) / 2, (Math.sin(angle) * reach) / 2)
  sprite.scale.set(
    (radius * 2 + reach) / SHADOW_ELLIPSE.width,
    (radius * 2 * SHADOW_BREADTH) / SHADOW_ELLIPSE.height,
  )
  sprite.alpha = shadow.alpha
}

function registerArm(sprite: Sprite, arm: CharacterCastSet['leftArm'], travelPixels: number): void {
  sprite.anchor.set(arm.pivot.x / CHARACTER_FRAME_SIZE, arm.pivot.y / CHARACTER_FRAME_SIZE)
  sprite.position.set(
    (arm.anchor.x - CHARACTER_FRAME_SIZE / 2) * CHARACTER_SCALE,
    (arm.anchor.y - CHARACTER_FRAME_SIZE / 2 + travelPixels) * CHARACTER_SCALE,
  )
}

function drawFallback(fallback: Graphics, character: CharacterDrawable, rotation: number): void {
  fallback.clear()
  fallback
    .circle(0, 0, character.radius)
    .fill(character.fill)
    .stroke({ color: PALETTE.backdrop, width: 2 })
    .moveTo(0, 0)
    .lineTo(0, character.radius * 1.8)
    .stroke({ color: PALETTE.backdrop, width: 2 })
  fallback.rotation = rotation
}

function drawFarMark(
  mark: Graphics,
  radius: number,
  tint: keyof typeof HEARTHSIDE_STYLE.palette,
  rotation: number,
): void {
  mark.clear()
  mark
    .circle(0, 0, radius)
    .fill(HEARTHSIDE_STYLE.palette[tint])
    .stroke({ color: HEARTHSIDE_STYLE.palette.backdrop, width: 1.5 })
    .moveTo(0, 0)
    .lineTo(0, radius * 1.8)
    .stroke({ color: HEARTHSIDE_STYLE.palette.bone, width: 1.5 })
  mark.rotation = rotation
}

function textureViews(atlas: Texture, grid: FrameGrid): Readonly<Record<string, Texture>> {
  return Object.fromEntries(
    grid.names.map((name) => [
      name,
      new Texture({ source: atlas.source, frame: frameRectangle(grid, name) }),
    ]),
  )
}

function requiredTexture(textures: Readonly<Record<string, Texture>>, name: string): Texture {
  const texture = textures[name]
  if (texture === undefined) throw new Error(`Three Branches character frame is missing: ${name}`)
  return texture
}

function requiredSet(
  sets: Readonly<Record<string, CharacterSetArt>>,
  name: string,
): CharacterSetArt {
  const set = sets[name]
  if (set === undefined) throw new Error(`Three Branches character cast set is missing: ${name}`)
  return set
}

function requiredPart<Value>(value: Value | null, name: string): Value {
  if (value === null) throw new Error(`Three Branches character ${name} is not installed.`)
  return value
}
