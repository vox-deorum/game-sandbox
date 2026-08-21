import { stableHashParts } from '@renderers/base/math.js'
import { Container, Graphics, Sprite, Texture } from 'pixi.js'

import { THREE_BRANCHES_ASSET_CATALOG } from '../assets.js'
import type { RoofFramesTreatment } from '../core/presentation.js'
import { HEARTHSIDE_STYLE, PALETTE, THREE_BRANCHES_PRESENTATION } from '../core/presentation.js'
import type { FrameScene, StaticDrawable, StaticScene } from '../core/types.js'
import { pointToWorld } from '../map/scene.js'
import { frameRectangle } from '../ui/tint.js'

/** One world-cell-covered building roof frame is authored at this many pixels. */
const ROOF_FRAME_CELL = 64

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

/** The buildings atlas page sliced into named roof frames. */
export type RoofArt = Readonly<Record<string, Texture>>

/** Operations exposed by the retained semantic roof display layer. */
export interface RoofLayer {
  /** Preflight and install roof art, building every building's tile plan once. */
  install(art: RoofArt): void
  /** Fix each building's target alpha from recorded occupancy, snapping when requested. */
  setTargets(scene: FrameScene, snap: boolean): void
  /** Ease roofs toward their targets. Returns true while any roof is unsettled. */
  advance(dtMs: number): boolean
}

/** One roof tile placement on a building's semantic rect. */
export interface RoofTile {
  col: number
  row: number
  role: 'corner' | 'edge' | 'ridge' | 'fill'
  frame: string
  rotation: number
}

interface RoofNode {
  item: StaticDrawable
  container: Container
  currentAlpha: number
  targetAlpha: number
}

/** Slice the buildings atlas page into named roof frames. */
export function createRoofArt(atlasTexture: Texture): RoofArt {
  const atlas = THREE_BRANCHES_ASSET_CATALOG.find((item) => item.name === 'buildings')
  if (atlas === undefined || 'layers' in atlas) {
    throw new Error('Three Branches buildings atlas is missing.')
  }
  return Object.fromEntries(
    atlas.frames.names.map((frame) => [
      frame,
      new Texture({ source: atlasTexture.source, frame: frameRectangle(atlas.frames, frame) }),
    ]),
  )
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
        for (const tile of roofTilePlan(node.item, cellSize)) {
          const spriteNode = new Sprite({
            label: `roof-tile:${tile.col}:${tile.row}`,
            texture: roofTexture(nextArt, tile.frame),
          })
          spriteNode.anchor.set(0.5)
          spriteNode.scale.set(cellSize / ROOF_FRAME_CELL)
          spriteNode.position.set(
            node.item.rect.x + (tile.col + 0.5) * cellSize,
            node.item.rect.y + (tile.row + 0.5) * cellSize,
          )
          spriteNode.rotation = tile.rotation
          node.container.addChild(spriteNode)
        }
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
  for (const building of scene.buildings) {
    const treatment = roofTreatment(building.type)
    roofTexture(nextArt, treatment.corner)
    roofTexture(nextArt, treatment.edge)
    roofTexture(nextArt, treatment.ridge)
    for (const frame of treatment.fills) roofTexture(nextArt, frame)
  }
}

function roofTreatment(type: string): RoofFramesTreatment {
  const treatment = HEARTHSIDE_STYLE.roofs.frames[type]
  if (treatment === undefined) {
    throw new Error(`Three Branches building type has no roof treatment: ${type}`)
  }
  return treatment
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

function roofTexture(frames: RoofArt, name: string): Texture {
  const value = frames[name]
  if (value === undefined) throw new Error(`Three Branches roof frame is missing: ${name}`)
  return value
}

function fillFrame(fills: readonly string[], buildingId: string, col: number, row: number): string {
  // presentation.json validation guarantees at least one fill, so the hash index is always in range.
  return fills[stableHashParts('three-branches-roof', buildingId, col, row) % fills.length]!
}

/**
 * Plan the tile grid for one semantic building rect at the given cell size. Corners quarter-rotate,
 * edges run along the perimeter, the ridge spans the middle row's interior columns, and every other
 * interior cell picks a fill deterministically from the configured list.
 */
export function roofTilePlan(building: StaticDrawable, cellSize: number): readonly RoofTile[] {
  const treatment = roofTreatment(building.type)
  const width = Math.round(building.rect.width / cellSize)
  const height = Math.round(building.rect.height / cellSize)
  const ridgeRow = Math.floor(height / 2)
  const tiles: RoofTile[] = []
  const push = (tile: RoofTile) => tiles.push(tile)
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const top = row === 0
      const bottom = row === height - 1
      const left = col === 0
      const right = col === width - 1
      if (top && left) push({ col, row, role: 'corner', frame: treatment.corner, rotation: 0 })
      else if (top && right)
        push({ col, row, role: 'corner', frame: treatment.corner, rotation: Math.PI / 2 })
      else if (bottom && right)
        push({ col, row, role: 'corner', frame: treatment.corner, rotation: Math.PI })
      else if (bottom && left)
        push({ col, row, role: 'corner', frame: treatment.corner, rotation: -Math.PI / 2 })
      else if (top) push({ col, row, role: 'edge', frame: treatment.edge, rotation: 0 })
      else if (bottom) push({ col, row, role: 'edge', frame: treatment.edge, rotation: Math.PI })
      else if (left) push({ col, row, role: 'edge', frame: treatment.edge, rotation: -Math.PI / 2 })
      else if (right) push({ col, row, role: 'edge', frame: treatment.edge, rotation: Math.PI / 2 })
      else if (row === ridgeRow)
        push({ col, row, role: 'ridge', frame: treatment.ridge, rotation: 0 })
      else {
        push({
          col,
          row,
          role: 'fill',
          frame: fillFrame(treatment.fills, building.id, col, row),
          rotation: 0,
        })
      }
    }
  }
  return tiles
}
