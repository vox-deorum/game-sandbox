import { Container, Graphics, Sprite, Texture } from 'pixi.js'

import { HEARTHSIDE_STYLE, PALETTE, THREE_BRANCHES_PRESENTATION } from '../core/presentation.js'
import type { FrameScene, StaticDrawable, StaticScene } from '../core/types.js'
import { pointToWorld } from '../map/scene.js'

/** One semantic building cell is authored at this many roof-art pixels. */
const ROOF_SOURCE_CELL = 128

type RoofKind = 'home' | 'inn' | 'shed'

interface RoofPageSize {
  width: number
  height: number
}

const ROOF_PAGE_SIZES: Readonly<Record<RoofKind, RoofPageSize>> = {
  home: { width: 1024, height: 896 },
  inn: { width: 1536, height: 1280 },
  shed: { width: 1024, height: 1024 },
}

/** Draw semantic building extents while the terrain-art load is still pending. */
export function drawBuildings(layer: Container, scene: StaticScene): Container {
  const outlines = new Container()
  for (const building of scene.buildings) {
    outlines.addChild(
      new Graphics()
        .rect(building.rect.x, building.rect.y, building.rect.width, building.rect.height)
        .fill({ color: PALETTE.building, alpha: 0.12 })
        .stroke({ color: PALETTE.building, width: 2, alpha: 0.8 }),
    )
  }
  layer.addChild(outlines)
  return outlines
}

/** The three one-frame pages that draw semantic building roofs. */
export interface RoofArt {
  readonly home: Texture
  readonly inn: Texture
  readonly shed: Texture
}

/** Operations exposed by the retained semantic roof display layer. */
export interface RoofLayer {
  /** Preflight and install roof art, retaining one sprite for every semantic building. */
  install(art: RoofArt): void
  /** Fix each building's target alpha from recorded occupancy, snapping when requested. */
  setTargets(scene: FrameScene, snap: boolean): void
  /** Ease roofs toward their targets. Returns true while any roof is unsettled. */
  advance(dtMs: number): boolean
}

interface RoofNode {
  item: StaticDrawable
  container: Container
  currentAlpha: number
  targetAlpha: number
}

/** Validate and expose the separate full-roof atlas pages. */
export function createRoofArt(pages: RoofArt): RoofArt {
  validateRoofArt(pages)
  return pages
}

/** Build each building's retained roof container and reconcile occupancy and easing. */
export function createRoofLayer(layer: Container, scene: StaticScene): RoofLayer {
  const cellSize = THREE_BRANCHES_PRESENTATION.unitsPerMetre * scene.village.size.cellSize
  const nodes = new Map<string, RoofNode>()
  let art: RoofArt | null = null

  for (const building of scene.buildings) {
    const container = new Container({ label: `roof:${building.id}` })
    container.alpha = 1
    layer.addChild(container)
    nodes.set(building.id, { item: building, container, currentAlpha: 1, targetAlpha: 1 })
  }

  return {
    install(nextArt) {
      if (art !== null) return
      preflightRoofArt(nextArt, scene)
      for (const node of nodes.values()) {
        const spriteNode = new Sprite({
          label: 'roof-sprite',
          texture: roofTexture(nextArt, node.item.type),
        })
        spriteNode.anchor.set(0.5)
        spriteNode.scale.set(cellSize / ROOF_SOURCE_CELL)
        spriteNode.position.set(
          node.item.rect.x + node.item.rect.width / 2,
          node.item.rect.y + node.item.rect.height / 2,
        )
        spriteNode.rotation = roofRotation(node.item.facing)
        node.container.addChild(spriteNode)
      }
      art = nextArt
    },
    setTargets(frame, snap) {
      if (art === null) return
      for (const node of nodes.values()) {
        const target = buildingOccupied(frame, node.item) ? HEARTHSIDE_STYLE.roofs.clearAlpha : 1
        node.targetAlpha = target
        if (snap) {
          node.currentAlpha = target
          node.container.alpha = target
        }
      }
    },
    advance(dtMs) {
      if (art === null) return false
      const rate = (1 - HEARTHSIDE_STYLE.roofs.clearAlpha) / HEARTHSIDE_STYLE.roofs.fadeMs
      const elapsed = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0
      let active = false
      for (const node of nodes.values()) {
        if (node.currentAlpha === node.targetAlpha) continue
        const remaining = node.targetAlpha - node.currentAlpha
        const step = Math.min(Math.abs(remaining), elapsed * rate)
        node.currentAlpha += remaining < 0 ? -step : step
        if (Math.abs(node.targetAlpha - node.currentAlpha) < 1e-6)
          node.currentAlpha = node.targetAlpha
        node.container.alpha = node.currentAlpha
        active = true
      }
      return active
    },
  }
}

function preflightRoofArt(nextArt: RoofArt, scene: StaticScene): void {
  validateRoofArt(nextArt)
  for (const building of scene.buildings) roofTexture(nextArt, building.type)
}

function validateRoofArt(art: RoofArt): void {
  for (const [kind, size] of Object.entries(ROOF_PAGE_SIZES) as readonly [RoofKind, RoofPageSize][]) {
    const texture = roofTexture(art, kind)
    if (
      texture.frame.x !== 0 ||
      texture.frame.y !== 0 ||
      texture.frame.width !== size.width ||
      texture.frame.height !== size.height
    ) {
      throw new Error(
        `Three Branches ${kind} roof page must be one ${size.width}x${size.height} frame.`,
      )
    }
  }
}

function roofTexture(art: RoofArt, type: string): Texture {
  if (type !== 'home' && type !== 'inn' && type !== 'shed') {
    throw new Error(`Three Branches building type has no roof art: ${type}`)
  }
  const texture = art[type]
  if (texture === undefined) throw new Error(`Three Branches ${type} roof page is missing.`)
  return texture
}

function roofRotation(facing: string | undefined): number {
  switch (facing) {
    case undefined:
    case 'north':
      return 0
    case 'east':
      return Math.PI / 2
    case 'south':
      return Math.PI
    case 'west':
      return -Math.PI / 2
    default:
      throw new Error(`Three Branches building facing is invalid: ${facing}`)
  }
}

/** Whether any recorded character stands within this building's semantic world rectangle. */
export function buildingOccupied(frame: FrameScene, building: StaticDrawable): boolean {
  const dynamic = frame.dynamic
  if (dynamic === null) return false
  const village = frame.static.village
  return dynamic.characters.some((character) => {
    const point = pointToWorld(village, character.x, character.y)
    return (
      point.x >= building.rect.x &&
      point.x <= building.rect.x + building.rect.width &&
      point.y >= building.rect.y &&
      point.y <= building.rect.y + building.rect.height
    )
  })
}
