/** Deterministic white-crane dressing with no gameplay footprint. */
import { stableHash } from '@renderers/base/math.js'
import { applyTexture, centeredSprite } from '@renderers/base/pixi-helpers.js'
import { Container, Sprite, Texture } from 'pixi.js'

import type { ThreeBranchesAssetName } from './assets.js'
import { WORLD_SCALE, WORLD_SIZE_METERS } from './geometry.js'
import { PRESENTATION } from './presentation.js'
import type { Palette } from './scene.js'

export interface CranePresentation {
  asset: 'craneA' | 'craneB'
  nextAsset: 'craneA' | 'craneB'
  poseMix: number
  x: number
  y: number
  rotation: number
}

type TextureFor = (name: ThreeBranchesAssetName) => Texture | null

interface CraneNode {
  root: Container
  current: Sprite
  next: Sprite
}

export interface CraneLayerSnapshot {
  asset: string
  alpha: number
  nextAsset: string
  nextAlpha: number
  x: number
  y: number
  rotation: number
  visible: boolean
}

export class CraneLayer {
  readonly view = new Container()
  private readonly nodes: CraneNode[] = []
  private readonly count: number

  constructor(
    private readonly layoutKey: string,
    palette: Palette,
    private readonly textureFor: TextureFor,
  ) {
    this.count = 1 + (stableHash(layoutKey) % PRESENTATION.cranes.count)
    for (let index = 0; index < this.count; index += 1) {
      const root = new Container()
      const current = craneSprite(palette.bone)
      const next = craneSprite(palette.bone)
      root.addChild(current, next)
      this.nodes.push({ root, current, next })
      this.view.addChild(root)
    }
    this.view.eventMode = 'none'
  }

  update(tick: number): void {
    for (const [index, node] of this.nodes.entries()) {
      const presentation = cranePresentationFor(this.layoutKey, index, tick)
      applyPose(node.current, presentation.asset, 1 - presentation.poseMix, this.textureFor)
      applyPose(node.next, presentation.nextAsset, presentation.poseMix, this.textureFor)
      node.root.position.set(presentation.x, presentation.y)
      node.root.rotation = presentation.rotation
    }
  }

  /** Read the retained crane sprites in their stable construction order. */
  snapshot(): CraneLayerSnapshot[] {
    return this.nodes.map((node) => ({
      asset: node.current.label,
      alpha: node.current.alpha,
      nextAsset: node.next.label,
      nextAlpha: node.next.alpha,
      x: node.root.x,
      y: node.root.y,
      rotation: node.root.rotation,
      visible: node.current.visible || node.next.visible,
    }))
  }

  destroy(): void {
    this.nodes.length = 0
    this.view.destroy({ children: true })
  }
}

export function cranePresentationFor(
  layoutKey: string,
  index: number,
  tick: number,
): CranePresentation {
  const seed = stableHash(`${layoutKey}:crane:${index}`)
  const period = PRESENTATION.cranes.periodTicks
  const phase = ((tick + seed) % period) / period
  const margin = PRESENTATION.cranes.marginMeters
  const travelStart = -margin
  const travelSpan = WORLD_SIZE_METERS + margin * 2
  const leftToRight = (seed & 1) === 0
  const progress = leftToRight ? phase : 1 - phase
  const laneSpan = WORLD_SIZE_METERS - margin * 2
  const lane = margin + ((seed >>> 8) % Math.max(1, Math.floor(laneSpan)))
  const xMeters = travelStart + progress * travelSpan
  const sway = Math.sin(phase * Math.PI * 2 + index) * 2.2
  // The crane art is drawn facing north, like every other rotatable sprite here, so it turns onto
  // the tangent of the lane it is actually flying: east or west, tilted by the sway it is riding.
  const swayRate = Math.cos(phase * Math.PI * 2 + index) * 2.2 * Math.PI * 2
  const heading = Math.atan2(swayRate, (leftToRight ? 1 : -1) * travelSpan)
  const posePosition = phase * 8
  const poseIndex = Math.floor(posePosition)
  const asset = poseIndex % 2 === 0 ? 'craneA' : 'craneB'
  return {
    asset,
    nextAsset: asset === 'craneA' ? 'craneB' : 'craneA',
    poseMix: posePosition - poseIndex,
    x: xMeters * WORLD_SCALE,
    y: (lane + sway) * WORLD_SCALE,
    rotation: heading + Math.PI / 2,
  }
}

function craneSprite(tint: string): Sprite {
  const sprite = centeredSprite()
  sprite.tint = tint
  return sprite
}

function applyPose(
  sprite: Sprite,
  asset: 'craneA' | 'craneB',
  alpha: number,
  textureFor: TextureFor,
): void {
  const texture = textureFor(asset)
  applyTexture(
    sprite,
    texture,
    PRESENTATION.cranes.spriteWidthMeters * WORLD_SCALE,
    PRESENTATION.cranes.spriteHeightMeters * WORLD_SCALE,
  )
  sprite.label = asset
  sprite.alpha = alpha * 0.76
  sprite.visible = texture !== null && alpha > 0
}
