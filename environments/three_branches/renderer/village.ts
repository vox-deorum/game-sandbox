/** Mount-once Hearthside village geometry split below and above dynamic occupants. */
import { degreesToRadians, stableHash } from '@renderers/base/math.js'
import { centeredSprite } from '@renderers/base/pixi-helpers.js'
import { Container, Graphics, Sprite, Texture, TilingSprite } from 'pixi.js'

import type { ThreeBranchesAssetName } from './assets.js'
import { offsetPolyline, WORLD_SCALE } from './geometry.js'
import type { Point } from './overlay.js'
import { PRESENTATION } from './presentation.js'
import type { Palette, StaticScene, WorldLine } from './scene.js'

interface TextureBinding {
  name: ThreeBranchesAssetName
  sprite: Sprite | TilingSprite
  width: number
  height: number
  /** Set on a tiling band: the run length one repeat of the artwork covers. */
  tileLength?: number
}

export interface VillageArt {
  lower: Container
  upper: Container
  setTextures(textureFor: (name: ThreeBranchesAssetName) => Texture | null): void
}

const RIPPLES = ['rippleA', 'rippleB', 'rippleC'] as const
const ROAD_BRUSHES = ['roadBrushA', 'roadBrushB', 'roadBrushC'] as const

/** Draw immutable decoded geometry once, keeping open floors below and wall bands above people. */
export function createVillage(scene: StaticScene, palette: Palette): VillageArt {
  const lower = new Container()
  const upper = new Container()
  lower.eventMode = 'none'
  upper.eventMode = 'none'
  const bindings: TextureBinding[] = []
  const widen = PRESENTATION.surfaces.widenMeters * WORLD_SCALE
  const edge = PRESENTATION.surfaces.edgeBandMeters * WORLD_SCALE

  // Water, road, and footpath surfaces are drawn here and nowhere else. The overlay's ground grid
  // is a one-metre sampling of the very same geometry, so it paints land under them and leaves the
  // shape of each surface to these smooth strokes.
  //
  // Every channel fills in one pass, so no channel paints over the water it meets at a fork.
  const waterways = new Graphics()
  for (const channel of scene.channels) drawLine(waterways, channel, palette.water, channel.width)
  lower.addChild(waterways)
  for (const [index, channel] of scene.channels.entries()) {
    const ripple = RIPPLES[index % RIPPLES.length] ?? 'rippleA'
    addBand(lower, bindings, ripple, channel.points, channel.width * 0.45, palette.bone, 0.2)
    addEdges(lower, bindings, 'bankEdge', channel.points, channel.width, edge, palette.ink, 0.32)
  }

  // Footpaths lay down first and the road covers them, so the through route reads as the through
  // route wherever a path meets it rather than being cut into pieces by its own side streets.
  const paths = new Graphics()
  for (const footpath of scene.footpaths) {
    drawLine(paths, footpath, palette.parchment, footpath.width + widen)
  }
  lower.addChild(paths)
  for (const [index, footpath] of scene.footpaths.entries()) {
    const width = footpath.width + widen
    const brush = ROAD_BRUSHES[(index + 1) % ROAD_BRUSHES.length] ?? 'roadBrushB'
    addBand(lower, bindings, brush, footpath.points, width * 0.5, palette.timber, 0.12)
    addEdges(lower, bindings, 'pathEdge', footpath.points, width, edge * 0.7, palette.ink, 0.24)
  }

  const roadWidth = scene.road.width + widen
  const road = new Graphics()
  drawLine(road, scene.road, palette.silt, roadWidth)
  lower.addChild(road)
  addBand(lower, bindings, 'roadBrushA', scene.road.points, roadWidth * 0.5, palette.timber, 0.14)
  addEdges(lower, bindings, 'roadEdge', scene.road.points, roadWidth, edge, palette.timber, 0.3)

  for (const building of scene.buildings) {
    const floor = new Graphics()
    floor
      .rect(-building.width / 2, -building.depth / 2, building.width, building.depth)
      .fill(building.type === 'inn' ? palette.silt : palette.parchment)
      .stroke({ color: palette.ink, width: 1 })
    floor.position.set(building.center.x, building.center.y)
    floor.rotation = degreesToRadians(building.rotation)
    lower.addChild(floor)
    addSprite(
      lower,
      bindings,
      floorAsset(building.type),
      building.center.x,
      building.center.y,
      building.width,
      building.depth,
      degreesToRadians(building.rotation),
      palette.timber,
      0.32,
    )
  }

  for (const bridge of scene.bridges) {
    const deck = new Graphics()
    deck
      .rect(-bridge.span / 2, -bridge.width / 2, bridge.span, bridge.width)
      .fill(palette.timber)
      .stroke({ color: palette.ink, width: 2 })
    deck.position.set(bridge.position.x, bridge.position.y)
    deck.rotation = degreesToRadians(bridge.heading)
    lower.addChild(deck)
    addSprite(
      lower,
      bindings,
      'bridgePlanks',
      bridge.position.x,
      bridge.position.y,
      bridge.span,
      bridge.width,
      degreesToRadians(bridge.heading),
      palette.bone,
      0.42,
    )
  }

  const shadows = new Graphics()
  lower.addChild(shadows)
  for (const item of scene.scenery) {
    shadows.ellipse(item.position.x + 2, item.position.y + 3, item.radius, item.radius * 0.7).fill({
      color: palette.ink,
      alpha: 0.22,
    })
    const asset = sceneryAsset(item.id, item.type)
    addSprite(
      lower,
      bindings,
      asset,
      item.position.x,
      item.position.y,
      item.radius * 2.3,
      item.radius * 2.3,
      degreesToRadians(stableHash(item.id) % 360),
      item.type === 'pine' ? palette.pine : palette.timber,
      0.94,
    )
  }

  const walls = new Graphics()
  for (const building of scene.buildings) {
    for (const wall of building.walls) {
      walls
        .moveTo(wall.start.x, wall.start.y)
        .lineTo(wall.end.x, wall.end.y)
        .stroke({ color: palette.timber, width: 6, cap: 'square' })
      walls
        .moveTo(wall.start.x, wall.start.y)
        .lineTo(wall.end.x, wall.end.y)
        .stroke({ color: palette.ink, width: 2, cap: 'square' })
      addBand(upper, bindings, 'wallBand', [wall.start, wall.end], 6, palette.timber, 0.68)
      addBand(upper, bindings, 'eaveBand', [wall.start, wall.end], 3, palette.ink, 0.6)
    }
    const doorwayHeading = doorwayTangentRotation(building)
    addSprite(
      upper,
      bindings,
      'doorwayMark',
      building.doorway.position.x,
      building.doorway.position.y,
      building.doorway.width,
      WORLD_SCALE * 0.45,
      doorwayHeading,
      palette.bone,
      0.8,
    )
  }
  upper.addChildAt(walls, 0)

  return {
    lower,
    upper,
    setTextures(textureFor) {
      for (const binding of bindings) {
        const texture = textureFor(binding.name) ?? Texture.EMPTY
        binding.sprite.texture = texture
        binding.sprite.width = binding.width
        binding.sprite.height = binding.height
        if (binding.tileLength === undefined || texture.width === 0 || texture.height === 0) continue
        const tiling = binding.sprite as TilingSprite
        tiling.tileScale.set(binding.tileLength / texture.width, binding.height / texture.height)
      }
    },
  }
}

/** Align a doorway-width mark along its wall instead of along the outward wall normal. */
export function doorwayTangentRotation(
  building: Pick<StaticScene['buildings'][number], 'center' | 'doorway'>,
): number {
  const normal = Math.atan2(
    building.doorway.position.y - building.center.y,
    building.doorway.position.x - building.center.x,
  )
  return normal + Math.PI / 2
}

function floorAsset(type: string): ThreeBranchesAssetName {
  if (type === 'inn') return 'floorInn'
  if (type === 'shed') return 'floorRepair'
  return 'floorHome'
}

function sceneryAsset(id: string, type: string): ThreeBranchesAssetName {
  if (type === 'pine') {
    return (['pineA', 'pineB', 'pineC'] as const)[stableHash(id) % 3] ?? 'pineA'
  }
  if (type === 'post') return 'shrinePost'
  return stableHash(id) % 3 === 0 ? 'marketBarrel' : 'marketCrate'
}

function drawLine(graphics: Graphics, line: WorldLine, color: string, width: number): void {
  const [first, ...rest] = line.points
  if (first === undefined) return
  graphics.moveTo(first.x, first.y)
  for (const point of rest) graphics.lineTo(point.x, point.y)
  graphics.stroke({ color, width, cap: 'round', join: 'round' })
}

/** Run an edge strip down both sides of a surface, where its bank or shoulder actually is. */
function addEdges(
  layer: Container,
  bindings: TextureBinding[],
  name: ThreeBranchesAssetName,
  points: readonly Point[],
  surfaceWidth: number,
  bandWidth: number,
  tint: string,
  alpha: number,
): void {
  for (const side of [-1, 1]) {
    addBand(
      layer,
      bindings,
      name,
      offsetPolyline(points, (side * surfaceWidth) / 2),
      bandWidth,
      tint,
      alpha,
    )
  }
}

/**
 * Lay one strip of artwork along a polyline, centered on it. Each segment repeats the texture at a
 * fixed run length and picks the pattern up where the previous segment left it, so a long course
 * reads as one unbroken strip rather than a chain of separately stretched copies.
 */
function addBand(
  layer: Container,
  bindings: TextureBinding[],
  name: ThreeBranchesAssetName,
  points: readonly Point[],
  width: number,
  tint: string,
  alpha: number,
): void {
  const tileLength = PRESENTATION.surfaces.tileMeters * WORLD_SCALE
  let travelled = 0
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]
    const end = points[index + 1]
    if (start === undefined || end === undefined) continue
    const dx = end.x - start.x
    const dy = end.y - start.y
    const length = Math.hypot(dx, dy)
    if (length <= 0) continue
    const sprite = new TilingSprite({ texture: Texture.EMPTY, width: length, height: width })
    sprite.label = name
    sprite.rotation = Math.atan2(dy, dx)
    // The band's own top-left corner, backed off half its width along the segment normal.
    sprite.position.set(
      start.x + (dy / length) * (width / 2),
      start.y - (dx / length) * (width / 2),
    )
    sprite.tint = tint
    sprite.alpha = alpha
    sprite.tilePosition.x = -travelled
    layer.addChild(sprite)
    bindings.push({ name, sprite, width: length, height: width, tileLength })
    travelled += length
  }
}

function addSprite(
  layer: Container,
  bindings: TextureBinding[],
  name: ThreeBranchesAssetName,
  x: number,
  y: number,
  width: number,
  height: number,
  rotation: number,
  tint: string,
  alpha: number,
): void {
  const sprite = centeredSprite()
  sprite.label = name
  sprite.position.set(x, y)
  sprite.width = width
  sprite.height = height
  sprite.rotation = rotation
  sprite.tint = tint
  sprite.alpha = alpha
  layer.addChild(sprite)
  bindings.push({ name, sprite, width, height })
}
