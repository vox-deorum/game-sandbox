import { Container, Graphics, Sprite, Texture } from 'pixi.js'
import { THREE_BRANCHES_ASSET_CATALOG } from '../assets.js'
import { HEARTHSIDE_STYLE, PALETTE, THREE_BRANCHES_PRESENTATION } from '../core/presentation.js'
import type { CharacterDrawable, FrameScene } from '../core/types.js'
import { type FrameGrid, frameRectangle } from '../ui/tint.js'
import {
  CHARACTER_REST_FRAME,
  characterRotation,
  characterStyle,
  characterWalkFrame,
} from './characters-art.js'

const CHARACTER_SCALE = (THREE_BRANCHES_PRESENTATION.unitsPerMetre / 128) * 0.85

/** Loaded pages needed to assemble the retained character art. */
export interface CharacterAtlasTextures {
  body: Texture
  clothing: Texture
  arms: Texture
  details: Texture
  effects: Texture
}

/** Named atlas views shared by every retained character node. */
export interface CharacterArt {
  body: Readonly<Record<string, Texture>>
  clothing: Readonly<Record<string, Texture>>
  arms: Readonly<Record<string, Texture>>
  details: Readonly<Record<string, Texture>>
  shadow: Texture
  directionMark: Texture
}

/** Operations exposed by the retained character display layer. */
export interface CharacterLayer {
  /** Reconcile retained nodes toward one pure frame and camera readability state. */
  reconcile(scene: FrameScene, zoom: number, fittedZoom: number): void
  /** Replace provisional marks with the loaded Hearthside sprite assembly. */
  install(art: CharacterArt): void
}

interface CharacterNode {
  root: Container
  fallback: Graphics
  farMark: Graphics
  shadow: Sprite | null
  rotor: Container | null
  body: Sprite | null
  clothing: Sprite | null
  arms: Sprite | null
  detail: Sprite | null
  directionMark: Sprite | null
}

/** Slice the four character pages and two shared effect frames without changing their sources. */
export function createCharacterArt(atlases: CharacterAtlasTextures): CharacterArt {
  const manifest = THREE_BRANCHES_ASSET_CATALOG.find((item) => item.name === 'characters')
  if (manifest === undefined || !('layers' in manifest)) {
    throw new Error('Three Branches character atlases are missing.')
  }
  const layer = (name: string) => {
    const found = manifest.layers.find((item) => item.name === name)
    if (found === undefined) throw new Error(`Three Branches character layer is missing: ${name}`)
    return found
  }
  const effects = THREE_BRANCHES_ASSET_CATALOG.find((item) => item.name === 'effects')
  if (effects === undefined || 'layers' in effects) {
    throw new Error('Three Branches effects atlas is missing.')
  }
  const effectFrames = textureViews(atlases.effects, effects.frames)
  return {
    body: textureViews(atlases.body, layer('body').frames),
    clothing: textureViews(atlases.clothing, layer('clothing').frames),
    arms: textureViews(atlases.arms, layer('arms').frames),
    details: textureViews(atlases.details, layer('details').frames),
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
    reconcile(scene, zoom, fittedZoom) {
      const active = new Set(scene.characters.map((character) => character.id))
      for (const [id, node] of nodes) {
        if (!active.has(id)) {
          node.root.destroy({ children: true })
          nodes.delete(id)
        }
      }
      for (const character of scene.characters) {
        drawCharacter(
          nodeFor(character.id),
          character,
          scene.presentationTick,
          art,
          zoom,
          fittedZoom,
        )
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
    body: null,
    clothing: null,
    arms: null,
    detail: null,
    directionMark: null,
  }
}

function installNodeArt(node: CharacterNode, art: CharacterArt): void {
  if (node.rotor !== null || node.shadow !== null) return
  const shadow = characterSprite('character-shadow', art.shadow)
  shadow.tint = HEARTHSIDE_STYLE.palette.backdrop
  shadow.alpha = 0.45
  const rotor = new Container({ label: 'character-rotor' })
  const directionMark = characterSprite('character-direction-mark', art.directionMark)
  const body = characterSprite('character-body', requiredTexture(art.body, CHARACTER_REST_FRAME))
  const clothing = characterSprite(
    'character-clothing',
    requiredTexture(art.clothing, CHARACTER_REST_FRAME),
  )
  const arms = characterSprite('character-arms', requiredTexture(art.arms, CHARACTER_REST_FRAME))
  const detail = characterSprite('character-detail', Texture.EMPTY)
  directionMark.tint = HEARTHSIDE_STYLE.palette.ink
  body.tint = HEARTHSIDE_STYLE.palette.bone
  arms.tint = HEARTHSIDE_STYLE.palette.parchment
  rotor.addChild(directionMark, body, clothing, arms, detail)
  node.root.addChildAt(shadow, 0)
  node.root.addChildAt(rotor, 1)
  node.shadow = shadow
  node.rotor = rotor
  node.body = body
  node.clothing = clothing
  node.arms = arms
  node.detail = detail
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
  fractionalTick: number,
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
  const farView = zoom < fittedZoom * THREE_BRANCHES_PRESENTATION.farMarkZoomFactor
  node.farMark.visible = farView
  drawFarMark(node.farMark, character.radius, style.markTint, rotation)
  const shadow = requiredPart(node.shadow, 'shadow')
  const rotor = requiredPart(node.rotor, 'rotor')
  shadow.visible = !farView
  rotor.visible = !farView
  rotor.rotation = rotation
  if (farView) return

  const pose = characterWalkFrame(character.id, fractionalTick, character.moved)
  requiredPart(node.body, 'body').texture = requiredTexture(art.body, pose)
  const clothing = requiredPart(node.clothing, 'clothing')
  clothing.texture = requiredTexture(art.clothing, pose)
  clothing.tint = HEARTHSIDE_STYLE.palette[style.clothingTint]
  requiredPart(node.arms, 'arms').texture = requiredTexture(art.arms, pose)
  const detail = requiredPart(node.detail, 'detail')
  detail.visible = style.detail !== null
  if (style.detail !== null) detail.texture = requiredTexture(art.details, style.detail)
  detail.tint = HEARTHSIDE_STYLE.palette[style.detailTint]
}

function drawFallback(fallback: Graphics, character: CharacterDrawable, rotation: number): void {
  fallback.clear()
  fallback
    .circle(0, 0, character.radius)
    .fill(character.fill)
    .stroke({ color: PALETTE.backdrop, width: 2 })
    .moveTo(0, 0)
    .lineTo(0, -character.radius * 1.8)
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
    .lineTo(0, -radius * 1.8)
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

function requiredPart<Value>(value: Value | null, name: string): Value {
  if (value === null) throw new Error(`Three Branches character ${name} is not installed.`)
  return value
}
