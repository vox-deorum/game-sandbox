/**
 * Everything painted in tile space: the parchment sheet and its terrain, the capture zones, the
 * activation seal, and the movement range wash.
 *
 * The battlefield is built once per episode and then left alone, so every choice that looks random
 * here (which wash variant, which rotation, which edges carry mist) is driven by a hash of the tile
 * key and comes back identical on a rebuild. The zone, activation, and range functions redraw per
 * frame instead, because what they mark changes with the state.
 */
import { clear } from '@renderers/base/PixiRenderer.js'
import { type Container, Graphics } from 'pixi.js'

import type { CraneAssetName } from './assets.js'
import type { SpriteFactory } from './draw.js'
import type { rangePresentation } from './inspection.js'
import {
  FEATURE_MARKS,
  type MarkSpec,
  type PresentationLevel,
  TERRAIN_MARKS,
} from './presentation.js'
import {
  CRANE_STYLE,
  type CraneReachScene,
  HEX_DIRECTIONS,
  type HexTile,
  type Point,
  SCENE_HEIGHT,
  SCENE_WIDTH,
} from './scene.js'

type RangePresentation = ReturnType<typeof rangePresentation>

/** Paint the whole static battlefield: sheet, terrain, paper tooth, boundary, mist, and zones. */
export function drawBattlefield(
  layer: Container,
  sprite: SpriteFactory,
  scene: CraneReachScene,
  onDismiss: () => void,
): void {
  clear(layer)
  const board = new Graphics()
  board.eventMode = 'static'
  board.on('pointertap', onDismiss)
  board.rect(0, 0, scene.width, scene.height).fill(CRANE_STYLE.backdrop)
  const outer = scene.tiles.filter((tile) => tile.terrain !== 'void')
  const field = bleedPolygon(convexHull(outer.flatMap((tile) => tile.corners)), scene.hexRadius, 5)
  board.poly(points(field)).fill(CRANE_STYLE.board)
  for (const tile of outer) {
    board.poly(points(tile.corners)).fill(CRANE_STYLE.terrain[tile.terrain])
    board.poly(points(tile.corners)).stroke({ color: CRANE_STYLE.grid, width: 1.5, alpha: 0.55 })
  }
  layer.addChild(board)

  const paper = sprite('paperField', SCENE_WIDTH / 2, SCENE_HEIGHT / 2, SCENE_WIDTH, SCENE_HEIGHT)
  if (paper !== null) {
    paper.alpha = 0.26
    paper.blendMode = 'multiply'
    const mask = new Graphics().poly(points(field)).fill('#ffffff')
    paper.mask = mask
    layer.addChild(mask)
    layer.addChild(paper)
  }
  for (const tile of outer) drawTerrainMark(layer, sprite, tile, scene.hexRadius)
  drawBoundaryAndMist(layer, sprite, outer, scene.hexRadius)
  drawZones(layer, sprite, scene)
}

/** A tile's pigment pool, then its terrain mark, then any feature mark over that. */
function drawTerrainMark(
  layer: Container,
  sprite: SpriteFactory,
  tile: HexTile,
  radius: number,
): void {
  const wash = sprite(
    ['washHexA', 'washHexB', 'washHexC'][hash(tile.key) % 3] as CraneAssetName,
    tile.center.x,
    tile.center.y,
    radius * 2,
    radius * 2,
  )
  if (wash !== null) {
    wash.tint = CRANE_STYLE.terrain[tile.terrain]
    wash.alpha = tile.terrain === 'grass' ? 0.3 : 0.5
    wash.rotation = (hash(`${tile.key}:turn`) % 6) * (Math.PI / 3)
    layer.addChild(wash)
  }
  // Terrain draws first so a feature sitting on a hill reads over its contours. Grass and
  // the empty feature carry no mark: the muted reed wash leaves room for the salient ones.
  const terrainMark = TERRAIN_MARKS[tile.terrain]
  if (terrainMark !== undefined) drawMark(layer, sprite, terrainMark, tile, radius)
  const featureMark = FEATURE_MARKS[tile.feature]
  if (featureMark !== undefined) drawMark(layer, sprite, featureMark, tile, radius)
}

/** Place one mark sprite, and for marks with an alternate, sometimes a smaller offset second one. */
function drawMark(
  layer: Container,
  sprite: SpriteFactory,
  spec: MarkSpec,
  tile: HexTile,
  radius: number,
): void {
  const alternate = spec.alternate
  const flipped = alternate !== undefined && hash(tile.key) % 2 !== 0
  const width =
    spec.shape === 'canopy'
      ? Math.sqrt(3) * radius * 0.75
      : spec.shape === 'wide'
        ? radius * 1.4
        : radius * 1.45
  const height = spec.shape === 'wide' ? width / 3 : spec.shape === 'tuft' ? width / 2 : width
  const mark = sprite(
    flipped && alternate !== undefined ? alternate : spec.asset,
    tile.center.x,
    tile.center.y,
    width,
    height,
  )
  if (mark !== null) {
    mark.tint = spec.tint
    mark.alpha = spec.alpha
    layer.addChild(mark)
  }
  if (alternate === undefined || hash(`${tile.key}:second-sedge`) % 2 !== 0) return
  const second = sprite(
    flipped ? spec.asset : alternate,
    tile.center.x + radius * 0.2,
    tile.center.y + radius * 0.12,
    width * 0.72,
    height * 0.72,
  )
  if (second !== null) {
    second.tint = spec.tint
    second.alpha = 0.78
    layer.addChild(second)
  }
}

/** A dry-brush stroke along every outer edge, with mist bands over a handful of them. */
function drawBoundaryAndMist(
  layer: Container,
  sprite: SpriteFactory,
  tiles: readonly HexTile[],
  radius: number,
): void {
  const byKey = new Set(tiles.map((tile) => tile.key))
  const edges = boundaryEdges(tiles, (key) => byKey.has(key))
  for (const edge of edges) {
    const stroke = sprite(
      'edgeStroke',
      (edge.current.x + edge.next.x) / 2,
      (edge.current.y + edge.next.y) / 2,
      radius * 1.75,
      radius * 0.28,
    )
    if (stroke !== null) {
      stroke.tint = CRANE_STYLE.grid
      stroke.alpha = 0.64
      stroke.rotation = Math.atan2(edge.next.y - edge.current.y, edge.next.x - edge.current.x)
      layer.addChild(stroke)
    }
  }
  // Six mist bands, chosen by hash so they scatter around the sheet and stay put across rebuilds.
  for (const [index, edge] of [...edges]
    .sort((left, right) => hash(edgeKey(left)) - hash(edgeKey(right)))
    .slice(0, 6)
    .entries()) {
    const midpoint = {
      x: (edge.current.x + edge.next.x) / 2,
      y: (edge.current.y + edge.next.y) / 2,
    }
    const normal = {
      x: midpoint.x - edge.tile.center.x,
      y: midpoint.y - edge.tile.center.y,
    }
    const normalLength = Math.max(1, Math.hypot(normal.x, normal.y))
    const mist = sprite(
      index % 2 === 0 ? 'mistBandA' : 'mistBandB',
      midpoint.x + (normal.x / normalLength) * radius * 0.25,
      midpoint.y + (normal.y / normalLength) * radius * 0.25,
      radius * 3.8,
      radius * 1.4,
    )
    if (mist !== null) {
      mist.tint = CRANE_STYLE.mist
      mist.alpha = 0.2
      mist.rotation = Math.atan2(edge.next.y - edge.current.y, edge.next.x - edge.current.x)
      layer.addChild(mist)
    }
  }
}

/** Each zone's mulberry wash, its center emphasis, and dashed segments around its union outline. */
function drawZones(layer: Container, sprite: SpriteFactory, scene: CraneReachScene): void {
  const tilesByKey = new Map(scene.tiles.map((tile) => [tile.key, tile]))
  const wash = new Graphics()
  layer.addChild(wash)
  for (const zone of scene.zones) {
    for (const key of zone.tileKeys) {
      const tile = tilesByKey.get(key)
      if (tile !== undefined)
        wash.poly(points(tile.corners)).fill({ color: CRANE_STYLE.zone, alpha: 0.2 })
    }
    wash
      .circle(zone.center.x, zone.center.y, scene.hexRadius * 0.18)
      .fill({ color: CRANE_STYLE.zoneGlow, alpha: 0.5 })
    const zoneTiles = zone.tileKeys
      .map((key) => tilesByKey.get(key))
      .filter((tile): tile is HexTile => tile !== undefined)
    const zoneKeys = new Set(zoneTiles.map((tile) => tile.key))
    for (const edge of boundaryEdges(zoneTiles, (key) => zoneKeys.has(key))) {
      const dash = sprite(
        'zoneDash',
        (edge.current.x + edge.next.x) / 2,
        (edge.current.y + edge.next.y) / 2,
        scene.hexRadius * 1.6,
        scene.hexRadius * 0.32,
      )
      if (dash !== null) {
        dash.tint = CRANE_STYLE.zoneGlow
        dash.rotation = Math.atan2(edge.next.y - edge.current.y, edge.next.x - edge.current.x)
        layer.addChild(dash)
      }
    }
  }
}

/** The standard on each zone: a pennant where there is room for it, a seal ring where there is not. */
export function drawZoneMarkers(
  layer: Container,
  sprite: SpriteFactory,
  scene: CraneReachScene,
  level: PresentationLevel,
): void {
  clear(layer)
  for (const zone of scene.zones) {
    const marker =
      level === 'figure'
        ? sprite(
            'pennant',
            zone.center.x,
            zone.center.y - scene.hexRadius * 0.12,
            scene.hexRadius * 0.78,
            scene.hexRadius * 1.04,
          )
        : sprite(
            'sealRing',
            zone.center.x,
            zone.center.y,
            scene.hexRadius * 0.82,
            scene.hexRadius * 0.82,
          )
    if (marker !== null) {
      marker.tint = CRANE_STYLE.zone
      layer.addChild(marker)
    }
  }
}

/** The acting unit's gilt seal and under-glow. This is the only signal naming the actor. */
export function drawActivationSeal(
  layer: Container,
  sprite: SpriteFactory,
  position: { x: number; y: number },
  hexRadius: number,
): void {
  const glow = new Graphics()
  glow
    .circle(position.x, position.y, hexRadius * 0.74)
    .fill({ color: CRANE_STYLE.activation, alpha: 0.12 })
  glow
    .circle(position.x, position.y, hexRadius * 0.82)
    .stroke({ color: CRANE_STYLE.activation, width: Math.max(2, hexRadius * 0.08) })
  layer.addChild(glow)
  const ring = sprite('sealRing', position.x, position.y, hexRadius * 1.8, hexRadius * 1.8)
  if (ring !== null) {
    ring.tint = CRANE_STYLE.activation
    layer.addChild(ring)
  }
}

/** Wash the tiles a unit can reach, outline the perimeter, and ring the unit when inspected. */
export function drawRangeWash(
  layer: Container,
  scene: CraneReachScene,
  unitPosition: { x: number; y: number },
  reachable: ReadonlySet<string>,
  presentation: RangePresentation,
): void {
  const color = presentation.wash === 'bone' ? CRANE_STYLE.text : CRANE_STYLE.activation
  const outlineColor =
    presentation.outlineInk === 'dilute-ink' ? CRANE_STYLE.grid : CRANE_STYLE.activation
  const range = new Graphics()
  const reachableTiles = scene.tiles.filter((tile) => reachable.has(tile.key))
  for (const tile of reachableTiles) {
    range.poly(points(tile.corners)).fill({ color, alpha: presentation.alpha })
  }
  for (const edge of boundaryEdges(reachableTiles, (key) => reachable.has(key))) {
    drawRangeEdge(range, edge.current, edge.next, outlineColor, presentation.outline === 'dashed')
  }
  layer.addChild(range)
  if (presentation.ring) {
    const ring = new Graphics()
    ring
      .circle(unitPosition.x, unitPosition.y, scene.hexRadius * 0.69)
      .stroke({ color: CRANE_STYLE.text, width: Math.max(2, scene.hexRadius * 0.055) })
    layer.addChild(ring)
  }
}

/** The hovered range reads as a hand-dashed dilute-ink perimeter, not a grid of hex outlines. */
function drawRangeEdge(
  graphics: Graphics,
  start: { x: number; y: number },
  end: { x: number; y: number },
  color: string,
  dashed: boolean,
): void {
  if (!dashed) {
    graphics
      .moveTo(start.x, start.y)
      .lineTo(end.x, end.y)
      .stroke({ color, width: 1.2, alpha: 0.72 })
    return
  }
  const length = Math.hypot(end.x - start.x, end.y - start.y)
  const segments = Math.max(2, Math.floor(length / 10))
  for (let index = 0; index < segments; index += 2) {
    const from = index / segments
    const to = Math.min(1, (index + 0.62) / segments)
    graphics
      .moveTo(start.x + (end.x - start.x) * from, start.y + (end.y - start.y) * from)
      .lineTo(start.x + (end.x - start.x) * to, start.y + (end.y - start.y) * to)
      .stroke({ color, width: 1.5, alpha: 0.82 })
  }
}

/** One outer edge of a tile group: the corner pair to paint, and which tile and slot it came from. */
interface BoundaryEdge {
  tile: HexTile
  index: number
  current: Point
  next: Point
}

/**
 * The outer edges of a tile group: every corner pair whose neighbor across it falls outside the
 * group. The sheet outline, the capture zones, and the movement range all draw their perimeter
 * this way, differing only in which tiles count as inside and what they paint along each edge.
 */
function boundaryEdges(
  tiles: readonly HexTile[],
  inside: (tileKey: string) => boolean,
): BoundaryEdge[] {
  const edges: BoundaryEdge[] = []
  for (const tile of tiles) {
    for (let index = 0; index < tile.corners.length; index += 1) {
      const current = tile.corners[index]
      const next = tile.corners[(index + 1) % tile.corners.length]
      if (current === undefined || next === undefined) continue
      const [dq, dr] = HEX_DIRECTIONS[index] as readonly [number, number]
      if (!inside(`${tile.q + dq},${tile.r + dr}`)) edges.push({ tile, index, current, next })
    }
  }
  return edges
}

/** A stable identity for one edge, so the hash-driven choices along it survive a rebuild. */
function edgeKey(edge: BoundaryEdge): string {
  return `${edge.tile.key}:${edge.index}`
}

/** Flatten hex corners into the flat coordinate list Pixi's polygon calls expect. */
function points(corners: ReadonlyArray<{ x: number; y: number }>): number[] {
  return corners.flatMap((corner) => [corner.x, corner.y])
}

/** A stable hash over a tile key, so every random-looking choice survives a rebuild unchanged. */
function hash(value: string): number {
  let total = 2166136261
  for (const char of value) total = Math.imul(total ^ char.charCodeAt(0), 16777619)
  return total >>> 0
}

/** The outline of the played area, which the parchment sheet is cut from. */
function convexHull(points: ReadonlyArray<{ x: number; y: number }>): { x: number; y: number }[] {
  const sorted = [...points].sort((left, right) => left.x - right.x || left.y - right.y)
  const cross = (
    origin: { x: number; y: number },
    left: { x: number; y: number },
    right: { x: number; y: number },
  ) => (left.x - origin.x) * (right.y - origin.y) - (left.y - origin.y) * (right.x - origin.x)
  const half = (source: ReadonlyArray<{ x: number; y: number }>) => {
    const hull: { x: number; y: number }[] = []
    for (const point of source) {
      while (
        hull.length >= 2 &&
        cross(
          hull[hull.length - 2] as { x: number; y: number },
          hull[hull.length - 1] as { x: number; y: number },
          point,
        ) <= 0
      )
        hull.pop()
      hull.push(point)
    }
    return hull
  }
  return [...half(sorted).slice(0, -1), ...half([...sorted].reverse()).slice(0, -1)]
}

/** Push a polygon outward from its center, so the sheet bleeds past the outer tile edges. */
function bleedPolygon(
  points: ReadonlyArray<{ x: number; y: number }>,
  radius: number,
  bleed: number,
): { x: number; y: number }[] {
  const center = points.reduce(
    (total, point) => ({
      x: total.x + point.x / points.length,
      y: total.y + point.y / points.length,
    }),
    { x: 0, y: 0 },
  )
  return points.map((point) => {
    const length = Math.hypot(point.x - center.x, point.y - center.y)
    const scale = length === 0 ? 1 : (length + Math.min(bleed, radius * 0.12)) / length
    return {
      x: center.x + (point.x - center.x) * scale,
      y: center.y + (point.y - center.y) * scale,
    }
  })
}
