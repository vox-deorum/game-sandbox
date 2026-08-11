/** Retained prop stills, seek-safe active effects, and post-grade warmth. */
import { Container, Graphics, Sprite, Texture } from 'pixi.js'

import type { ThreeBranchesAssetName } from './assets.js'
import { activeEffectFor, emissiveAsset, propStillAsset } from './presentation.js'
import type { DynamicScene, Palette, StaticScene } from './scene.js'

interface PropNode {
  root: Container
  base: Graphics
  still: Sprite
  effectRoot: Container
  effect: Sprite
  emissiveRoot: Container
  emissive: Sprite
  staticProp: StaticScene['props'][number]
  state: string
}

type TextureFor = (name: ThreeBranchesAssetName) => Texture | null

export interface PropLayerSnapshot {
  id: string
  still: { asset: string; visible: boolean }
  effect: { asset: string; visible: boolean; alpha: number; rotation: number; y: number }
  emissive: { asset: string; visible: boolean; alpha: number; rotation: number; y: number }
}

/** Build permanent prop bases once and reconcile all state treatment by stable id. */
export class PropsLayer {
  readonly view = new Container()
  readonly effectsView = new Container()
  readonly emissivesView = new Container()
  private readonly nodes = new Map<string, PropNode>()

  constructor(
    staticScene: StaticScene,
    private readonly palette: Palette,
    private readonly textureFor: TextureFor,
  ) {
    for (const prop of staticScene.props) this.create(prop)
  }

  /** Resolve every prop's state treatment. One decoded tick is the unit of work here. */
  update(dynamic: DynamicScene): void {
    for (const dynamicProp of dynamic.props) {
      const node = this.nodes.get(dynamicProp.id)
      if (node === undefined) continue
      const { staticProp } = node
      node.state = dynamicProp.state
      const stillAsset = propStillAsset(staticProp.type, dynamicProp.state)
      const stillTexture = this.textureFor(stillAsset)
      applyTexture(node.still, stillTexture, staticProp.width, staticProp.depth)
      node.still.label = stillAsset
      node.base.alpha = stillTexture === null ? 0.82 : 0.18

      const effect = activeEffectFor(
        staticProp.type,
        dynamicProp.state,
        dynamic.tick,
        dynamicProp.id,
      )
      resetEffect(node.effect)
      resetEffect(node.emissive)
      const glow = emissiveAsset(staticProp.type, dynamicProp.state)
      if (glow !== null) {
        const size = Math.max(staticProp.width, staticProp.depth) * 2.4
        applyTexture(node.emissive, this.textureFor(glow), size, size)
        node.emissive.label = glow
        node.emissive.alpha = 0.78
        node.emissive.tint = this.palette.gilt
      }
      if (effect === null) continue
      const sprite = effect.postGrade ? node.emissive : node.effect
      const size = Math.max(staticProp.width, staticProp.depth) * (effect.postGrade ? 2.4 : 1.25)
      applyTexture(sprite, this.textureFor(effect.asset), size, size)
      sprite.label = effect.asset
      sprite.alpha = effect.alpha
      sprite.rotation = effect.rotation
      sprite.y = effect.offset
      sprite.tint = effect.postGrade ? this.palette.gilt : this.effectTint(staticProp.type)
    }
  }

  /**
   * Advance the sustained effects for one in-between frame. This runs on every animation frame, so
   * it moves the already-resolved sprites and never touches artwork or state treatment.
   */
  animate(tick: number): void {
    for (const node of this.nodes.values()) {
      const effect = activeEffectFor(node.staticProp.type, node.state, tick, node.staticProp.id)
      if (effect === null) continue
      const sprite = effect.postGrade ? node.emissive : node.effect
      sprite.alpha = effect.alpha
      sprite.rotation = effect.rotation
      sprite.y = effect.offset
    }
  }

  /** Read deterministic state from the retained Pixi nodes for seek-equivalence tests. */
  snapshot(): PropLayerSnapshot[] {
    return [...this.nodes.entries()]
      .map(([id, node]) => ({
        id,
        still: spriteSnapshot(node.still),
        effect: effectSnapshot(node.effect),
        emissive: effectSnapshot(node.emissive),
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  destroy(): void {
    this.nodes.clear()
    this.view.destroy({ children: true })
    this.effectsView.destroy({ children: true })
    this.emissivesView.destroy({ children: true })
  }

  private create(prop: StaticScene['props'][number]): void {
    const root = new Container()
    const base = new Graphics()
    base
      .roundRect(-prop.width / 2, -prop.depth / 2, prop.width, prop.depth, 2)
      .fill({ color: this.palette.timber, alpha: 0.34 })
      .stroke({ color: this.palette.ink, width: 1.5 })
    const still = centeredSprite()
    root.position.set(prop.position.x, prop.position.y)
    root.rotation = (prop.rotation * Math.PI) / 180
    root.addChild(base, still)

    const effectRoot = positionedRoot(prop)
    const effect = centeredSprite()
    effectRoot.addChild(effect)
    const emissiveRoot = positionedRoot(prop)
    const emissive = centeredSprite()
    emissiveRoot.addChild(emissive)

    const node = {
      root,
      base,
      still,
      effectRoot,
      effect,
      emissiveRoot,
      emissive,
      staticProp: prop,
      state: '',
    }
    this.nodes.set(prop.id, node)
    this.view.addChild(root)
    this.effectsView.addChild(effectRoot)
    this.emissivesView.addChild(emissiveRoot)
  }

  private effectTint(type: string): string {
    if (type === 'hearth') return this.palette.gilt
    if (type === 'pump') return this.palette.water
    if (type === 'shrine') return this.palette.bone
    return this.palette.ink
  }
}

function positionedRoot(prop: StaticScene['props'][number]): Container {
  const root = new Container()
  root.position.set(prop.position.x, prop.position.y)
  root.rotation = (prop.rotation * Math.PI) / 180
  return root
}

function centeredSprite(): Sprite {
  const sprite = new Sprite(Texture.EMPTY)
  sprite.anchor.set(0.5)
  sprite.visible = false
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

function resetEffect(sprite: Sprite): void {
  sprite.label = ''
  sprite.visible = false
  sprite.alpha = 1
  sprite.rotation = 0
  sprite.y = 0
}

function spriteSnapshot(sprite: Sprite): { asset: string; visible: boolean } {
  return { asset: sprite.label, visible: sprite.visible }
}

function effectSnapshot(sprite: Sprite): PropLayerSnapshot['effect'] {
  return {
    asset: sprite.label,
    visible: sprite.visible,
    alpha: sprite.alpha,
    rotation: sprite.rotation,
    y: sprite.y,
  }
}
