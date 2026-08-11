/** Retained Hearthside people reconciled by stable character id. */
import { Container, Graphics, Rectangle, Sprite, Texture } from 'pixi.js'

import type { ThreeBranchesAssetName } from './assets.js'
import { WORLD_SCALE } from './geometry.js'
import {
  type HandsFrame,
  handsBlendFor,
  headAssetFor,
  PRESENTATION,
  presentationFor,
  type PresentationLevel,
} from './presentation.js'
import type { DynamicScene, MotionScene, Palette } from './scene.js'

interface CharacterNode {
  root: Container
  facing: Container
  fallback: Graphics
  shadow: Sprite
  head: Sprite
  hands: Sprite
  nextHands: Sprite
  direction: Sprite
  level: PresentationLevel
}

type TextureFor = (name: ThreeBranchesAssetName) => Texture | null

export interface CharacterLayerSnapshot {
  id: string
  x: number
  y: number
  rotation: number
  presentation: string
  head: string
  hands: string
  handsAlpha: number
  nextHands: string
  nextHandsAlpha: number
  handsVisible: boolean
  directionVisible: boolean
}

/** Reconcile the cast without carrying animation state across replay seeks. */
export class CharactersLayer {
  readonly view = new Container()
  private readonly nodes = new Map<string, CharacterNode>()
  private readonly handsTextures = new Map<HandsFrame, Texture>()

  constructor(
    private readonly palette: Palette,
    private readonly textureFor: TextureFor,
  ) {}

  /** Resolve the cast's membership and artwork. One decoded tick is the unit of work here. */
  update(dynamic: DynamicScene, worldCssScale: number): void {
    const visible = new Set(dynamic.characters.map((character) => character.id))
    for (const [id, node] of this.nodes) {
      if (!visible.has(id)) {
        this.nodes.delete(id)
        node.root.destroy({ children: true })
      }
    }
    for (const character of dynamic.characters) {
      const node = this.nodes.get(character.id) ?? this.create(character.id)
      const headAsset = headAssetFor(character.id)
      const size = PRESENTATION.characters.spriteMeters * WORLD_SCALE
      node.level = presentationFor(character.radius * 2 * worldCssScale)
      node.fallback
        .clear()
        .circle(0, 0, character.radius)
        .fill({
          color: character.id === 'visitor' ? this.palette.cinnabar : this.palette.indigo,
          alpha: this.textureFor(headAsset) === null ? 1 : 0,
        })
      applyTexture(node.shadow, this.textureFor('shadowOval'), size * 0.9, size * 0.62)
      node.shadow.tint = this.palette.ink
      node.shadow.alpha = 0.5
      applyTexture(node.head, this.textureFor(headAsset), size, size)
      applyTexture(node.direction, this.textureFor('directionMark'), size * 0.72, size * 0.72)
      node.direction.tint = character.id === 'visitor' ? this.palette.cinnabar : this.palette.bone
      node.direction.visible = node.level === 'compact'
      node.head.alpha = node.level === 'compact' ? 0.9 : 1
      node.facing.label = node.level
      node.head.label = headAsset
      node.direction.label = 'directionMark'
    }
    this.applyMotion(dynamic)
  }

  /**
   * Place and pose the cast for one in-between frame. This runs on every animation frame, so it
   * touches only the transforms and the two cached hand textures the walk cycle cross-fades.
   */
  applyMotion(dynamic: MotionScene): void {
    const size = PRESENTATION.characters.spriteMeters * WORLD_SCALE
    for (const character of dynamic.characters) {
      const node = this.nodes.get(character.id)
      if (node === undefined) continue
      node.root.position.set(character.position.x, character.position.y)
      node.facing.rotation = spriteRotationForHeading(character.heading)
      const hands = handsBlendFor(dynamic.tick, character.id, character.moved)
      applyTexture(node.hands, this.handsTexture(hands.current), size, size)
      applyTexture(node.nextHands, this.handsTexture(hands.next), size, size)
      node.hands.visible = node.level !== 'compact'
      node.nextHands.visible = node.level !== 'compact' && hands.mix > 0
      node.hands.alpha = 1 - hands.mix
      node.nextHands.alpha = hands.mix
      node.hands.label = hands.current
      node.nextHands.label = hands.next
    }
  }

  /** Read the live retained pose without exposing mutable display objects to tests. */
  snapshot(): CharacterLayerSnapshot[] {
    return [...this.nodes.entries()]
      .map(([id, node]) => ({
        id,
        x: node.root.x,
        y: node.root.y,
        rotation: node.facing.rotation,
        presentation: node.facing.label,
        head: node.head.label,
        hands: node.hands.label,
        handsAlpha: node.hands.alpha,
        nextHands: node.nextHands.label,
        nextHandsAlpha: node.nextHands.alpha,
        handsVisible: node.hands.visible,
        directionVisible: node.direction.visible,
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  destroy(): void {
    this.nodes.clear()
    for (const texture of this.handsTextures.values()) texture.destroy(false)
    this.handsTextures.clear()
    this.view.destroy({ children: true })
  }

  private create(id: string): CharacterNode {
    const root = new Container()
    root.label = id
    const facing = new Container()
    const fallback = new Graphics()
    const shadow = centeredSprite()
    const hands = centeredSprite()
    const nextHands = centeredSprite()
    const head = centeredSprite()
    const direction = centeredSprite()
    root.addChild(shadow, fallback, facing)
    facing.addChild(hands, nextHands, head, direction)
    const node: CharacterNode = {
      root,
      facing,
      fallback,
      shadow,
      head,
      hands,
      nextHands,
      direction,
      level: 'detailed',
    }
    this.nodes.set(id, node)
    this.view.addChild(root)
    return node
  }

  private handsTexture(frame: HandsFrame): Texture | null {
    const cached = this.handsTextures.get(frame)
    if (cached !== undefined) return cached
    const sheet = this.textureFor('characterHands')
    if (sheet === null) return null
    const columns: readonly HandsFrame[] = ['rest', 'leftForward', 'pass', 'rightForward']
    const index = columns.indexOf(frame)
    const texture = new Texture({
      source: sheet.source,
      frame: new Rectangle(Math.max(0, index) * 192, 0, 192, 192),
    })
    this.handsTextures.set(frame, texture)
    return texture
  }
}

/** Convert east-zero overlay headings to sprites authored facing north. */
export function spriteRotationForHeading(heading: number): number {
  return ((heading + 90) * Math.PI) / 180
}

function centeredSprite(): Sprite {
  const sprite = new Sprite(Texture.EMPTY)
  sprite.anchor.set(0.5)
  return sprite
}

function applyTexture(
  sprite: Sprite,
  texture: Texture | null,
  width: number,
  height: number,
): void {
  sprite.texture = texture ?? Texture.EMPTY
  sprite.width = width
  sprite.height = height
  sprite.visible = texture !== null
}
