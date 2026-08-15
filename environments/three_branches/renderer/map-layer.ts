import {
  createSparseTiledGround,
  createTiledGround,
  type GroundView,
  solidColorTileset,
  type TiledGround,
  type TileGrid,
} from '@renderers/base/tiled-ground.js'
import { AlphaFilter, Container, FillPattern, Graphics, GraphicsPath, Matrix } from 'pixi.js'

import { fillTintHex, HEARTHSIDE_STYLE, THREE_BRANCHES_PRESENTATION } from './presentation.js'
import { PATTERN_CELLS, type TerrainArt, transparentUpperGrid } from './terrain-art.js'
import type {
  ContourCoordinate,
  TerrainContourChain,
  TerrainContourPlan,
  TerrainContourPoint,
  TerrainContourRing,
} from './terrain-contours.js'
import { terrainHash } from './terrain-contours.js'
import type { TerrainBridgeComponent, TerrainRoutePlan } from './terrain-routes.js'
import type { StaticScene } from './types.js'

/** The natural surface materials whose shared boundaries take the seam treatments. */
const NATURAL_SEAM_MATERIALS = new Set(['ground', 'field', 'reeds', 'water'])
const OVERLAY_MATERIALS = ['field', 'reeds', 'water'] as const
const STRUCTURE_NAMES = ['interior', 'doorway', 'wall'] as const

type SurfaceMaterial = (typeof OVERLAY_MATERIALS)[number] | 'road' | 'path'

/** One deterministic visible portion of a broken seam stroke along a contour chain. */
export interface SeamStrokeRun {
  readonly points: readonly TerrainContourPoint[]
  readonly alpha: number
  readonly closed: boolean
}

/** Return the configured composite alpha for one drawn surface material. */
export function materialLayerAlpha(material: SurfaceMaterial): number {
  if (material === 'road') return HEARTHSIDE_STYLE.terrain.routes.road.opacity
  if (material === 'path') return HEARTHSIDE_STYLE.terrain.routes.path.opacity
  const treatment = HEARTHSIDE_STYLE.terrain.fills[material]
  if (treatment === undefined) {
    throw new Error(`Three Branches presentation has no ${material} terrain fill.`)
  }
  return treatment.opacity
}

/** Draw the diagnostic fallback or the anti-aliased Hearthside terrain surfaces and seams. */
export function drawMap(layer: Container, scene: StaticScene, art?: TerrainArt): GroundView {
  if (art === undefined) return drawFallbackMap(layer, scene)
  const cellSize = THREE_BRANCHES_PRESENTATION.unitsPerMetre * scene.village.size.cellSize
  const owner = new Container()
  const grounds: GroundView[] = []
  const graphics: Graphics[] = []
  const span = {
    width: scene.village.size.cellsX * cellSize,
    height: scene.village.size.cellsY * cellSize,
  }
  const add = (graphic: Graphics, label: string): void => {
    graphic.label = label
    owner.addChild(graphic)
    graphics.push(graphic)
  }

  const ground = new Graphics()
  ground.rect(0, 0, span.width, span.height).fill(fillPatternFor(art, 'ground', cellSize))
  add(ground, 'terrain-ground')

  for (const material of OVERLAY_MATERIALS) {
    const surface = new Graphics()
    const pattern = fillPatternFor(art, material, cellSize)
    for (const path of componentPaths(art.contours, material, cellSize)) {
      surface.path(path).fill(pattern)
    }
    surface.alpha = materialLayerAlpha(material)
    add(surface, `terrain-${material}`)
  }

  const names = Object.fromEntries(scene.ground.map((ground) => [ground.code, ground.name]))
  const seamCover = routeCoverGraphics(art.routes, cellSize)
  const seams = [
    poolingGraphics(art.contours, cellSize),
    reedMarksGraphics(art.routes.visualRows, names, cellSize),
    inkGraphics(art.contours, cellSize, fillPatternFor(art, 'ink', cellSize)),
    hatchGraphics(art.contours, cellSize),
  ] as const
  for (const seam of seams) seam.setMask?.({ mask: seamCover, inverse: true })
  add(seams[0], 'terrain-seam-pooling')
  add(seams[1], 'terrain-reed-marks')
  add(seams[2], 'terrain-seam-ink')
  add(seams[3], 'terrain-seam-hatch')
  add(seamCover, 'terrain-seam-cover')

  const path = pathGuideGraphics(art.routes, cellSize, fillPatternFor(art, 'path', cellSize))
  path.alpha = materialLayerAlpha('path')
  add(path, 'terrain-path')

  const road = roadGuideGraphics(art.routes, cellSize, fillPatternFor(art, 'road', cellSize))
  road.filters = [new AlphaFilter({ alpha: materialLayerAlpha('road') })]
  add(road, 'terrain-road')

  const structures = createSparseTiledGround(
    exactTerrainGrid(scene.topFirstRows, names, STRUCTURE_NAMES),
    art.tileset,
    { cellSize, variant: art.variant },
  )
  structures.view.label = 'terrain-structures'
  owner.addChild(structures.view)
  grounds.push(structures)

  const planks = createSparseTiledGround(art.plankLayer, art.tileset, {
    cellSize,
    variant: art.variant,
  })
  const deckClip = bridgeDeckMask(art.routes.bridgeComponents, cellSize)
  planks.view.label = 'terrain-planks'
  deckClip.label = 'terrain-planks-mask'
  planks.view.mask = deckClip
  owner.addChild(planks.view, deckClip)
  grounds.push(planks)
  graphics.push(deckClip)

  layer.addChild(owner)
  return ownedTerrainView(owner, grounds, graphics, span)
}

/** Wrap one repeating pattern texture so world cells and the pattern grid stay aligned. */
function fillPatternFor(art: TerrainArt, material: string, cellSize: number): FillPattern {
  const texture = art.patterns[material]
  if (texture === undefined) {
    throw new Error(`Three Branches terrain art has no ${material} pattern.`)
  }
  const pattern = new FillPattern(texture, 'repeat')
  const scale = (cellSize * PATTERN_CELLS) / texture.width
  pattern.setTransform(new Matrix().scale(scale, scale))
  return pattern
}

/** One signed path per component of the material, including only its direct hole rings. */
export function componentPaths(
  plan: TerrainContourPlan,
  material: string,
  cellSize: number,
): GraphicsPath[] {
  const rings = new Map(plan.rings.map((ring) => [ring.id, ring]))
  const paths: GraphicsPath[] = []
  for (const component of plan.components) {
    if (component.exterior || component.material !== material) continue
    const outer = rings.get(component.outerRingId)
    if (outer === undefined) throw new Error(`Terrain component ${component.id} has no outer ring.`)
    const holes = component.holeRingIds.map((holeId) => {
      const hole = rings.get(holeId)
      if (hole === undefined)
        throw new Error(`Terrain component ${component.id} has a missing hole ring.`)
      return hole
    })
    paths.push(signedComponentPath(outer, holes, cellSize))
  }
  return paths
}

/** Darken one #rrggbb color multiplicatively toward black. */
export function darkenedColor(hex: string, amount: number): string {
  const value = hex.replace('#', '')
  if (value.length !== 6) throw new Error(`Terrain seam color ${hex} must be #rrggbb.`)
  const channel = (start: number): string =>
    Math.max(0, Math.round(Number.parseInt(value.slice(start, start + 2), 16) * (1 - amount)))
      .toString(16)
      .padStart(2, '0')
  return `#${channel(0)}${channel(2)}${channel(4)}`
}

/** Pool a darkened wash inside each natural overlay component along its boundary. */
export function poolingGraphics(plan: TerrainContourPlan, cellSize: number): Graphics {
  const pooling = new Graphics()
  const spec = HEARTHSIDE_STYLE.terrain.seams.pooling
  if (spec.widthCells <= 0 || spec.opacity <= 0) return pooling
  for (const material of OVERLAY_MATERIALS) {
    const treatment = HEARTHSIDE_STYLE.terrain.fills[material]
    if (treatment === undefined) {
      throw new Error(`Three Branches presentation has no ${material} terrain fill.`)
    }
    const color = darkenedColor(fillTintHex(treatment), spec.darken)
    for (const path of componentPaths(plan, material, cellSize)) {
      pooling.path(path).stroke({
        color,
        width: spec.widthCells * cellSize,
        alignment: 1,
        alpha: spec.opacity,
        cap: 'round',
        join: 'round',
      })
    }
  }
  return pooling
}

/** Chains drawn with the broken ink line: both faces are natural surface materials. */
export function inkedChain(chain: Pick<TerrainContourChain, 'materials'>): boolean {
  return chain.materials.every((material) => NATURAL_SEAM_MATERIALS.has(material))
}

/** The ink body is chunked into short pieces whose width and tone vary deterministically. */
const INK_PIECE_CELLS = 0.8
const INK_WIDTH_JITTER = 0.45
const INK_BLEED_WIDTH_FACTOR = 2.4
const INK_BLEED_ALPHA_FACTOR = 0.22

interface InkPiece {
  readonly points: readonly TerrainContourPoint[]
  readonly width: number
  readonly alpha: number
}

/**
 * Draw the hand-drawn ink line in deterministic broken runs along natural seams. Each run gets a
 * faint wide bleed underlay and a grain-textured body whose width and tone wobble piece by piece.
 */
export function inkGraphics(
  plan: TerrainContourPlan,
  cellSize: number,
  fill: FillPattern,
): Graphics {
  const ink = new Graphics()
  const spec = HEARTHSIDE_STYLE.terrain.seams.ink
  const color = HEARTHSIDE_STYLE.palette[spec.tint]
  for (const chain of plan.chains) {
    if (!inkedChain(chain)) continue
    for (const run of seamStrokeRuns(chain, spec, 'seam-ink')) {
      strokeRunPolyline(ink, run.points, cellSize, {
        color,
        width: spec.widthCells * INK_BLEED_WIDTH_FACTOR * cellSize,
        alpha: run.alpha * INK_BLEED_ALPHA_FACTOR,
        cap: 'round',
        join: 'round',
      })
      for (const piece of inkPieces(chain.id, run.points)) {
        strokeRunPolyline(ink, piece.points, cellSize, {
          fill,
          width: piece.width * cellSize,
          alpha: run.alpha * piece.alpha,
          cap: 'round',
          join: 'round',
        })
      }
    }
  }
  return ink
}

function inkPieces(chainId: string, points: readonly TerrainContourPoint[]): InkPiece[] {
  const spec = HEARTHSIDE_STYLE.terrain.seams.ink
  const pieces: InkPiece[] = []
  let bucket: number | undefined
  let active: TerrainContourPoint[] = []
  const push = (): void => {
    if (bucket === undefined || active.length < 2) return
    const widthUnit = hashUnit(terrainHash('seam-ink-body', chainId, bucket))
    const toneUnit = hashUnit(terrainHash('seam-ink-tone', chainId, bucket))
    pieces.push({
      points: active,
      width: spec.widthCells * (1 - INK_WIDTH_JITTER / 2 + INK_WIDTH_JITTER * widthUnit),
      alpha: 0.75 + 0.25 * toneUnit,
    })
  }
  for (const [index, point] of points.entries()) {
    const nextBucket = Math.floor(point.rawOffset / INK_PIECE_CELLS)
    if (bucket === undefined) {
      bucket = nextBucket
      active = [point]
      continue
    }
    active.push(point)
    if (nextBucket !== bucket && index < points.length - 1) {
      push()
      bucket = nextBucket
      active = [point]
    }
  }
  push()
  return pieces
}

function strokeRunPolyline(
  target: Graphics,
  points: readonly TerrainContourPoint[],
  cellSize: number,
  stroke: Parameters<Graphics['stroke']>[0],
): void {
  const first = points[0]
  if (first === undefined || points.length < 2) return
  target.moveTo(first.x * cellSize, first.y * cellSize)
  for (const point of points.slice(1)) target.lineTo(point.x * cellSize, point.y * cellSize)
  target.stroke(stroke)
}

/** Draw offset hatch lines on the water side of every shoreline, tapered beside bridges. */
export function hatchGraphics(plan: TerrainContourPlan, cellSize: number): Graphics {
  const hatch = new Graphics()
  const spec = HEARTHSIDE_STYLE.terrain.seams.waterHatch
  for (const chain of plan.chains) {
    if (chain.shorelineSpans.length === 0) continue
    const sign = chain.leftMaterial === 'water' ? 1 : -1
    for (const [lineIndex, offsetCells] of spec.offsetsCells.entries()) {
      const runs: SeamStrokeRun[] = []
      appendTaperedRuns(runs, chain, 0, chain.rawLength, spec.opacity / (lineIndex + 1), true)
      for (const run of runs) {
        const points = offsetPolyline(run.points, sign * offsetCells)
        const first = points[0]
        if (first === undefined) continue
        hatch.moveTo(first.x * cellSize, first.y * cellSize)
        for (const point of points.slice(1)) {
          hatch.lineTo(point.x * cellSize, point.y * cellSize)
        }
        if (run.closed) hatch.closePath()
        hatch.stroke({
          color: HEARTHSIDE_STYLE.palette[spec.tint],
          width: spec.widthCells * cellSize,
          alpha: run.alpha,
          cap: 'round',
          join: 'round',
        })
      }
    }
  }
  return hatch
}

/**
 * Scatter deterministic short stalk strokes inside every reed cell of the visual grid. The marks
 * carry the reed texture until a bolder authored reed frame pass lands in the atlas.
 */
export function reedMarksGraphics(
  rows: readonly string[],
  groundNameForCode: Readonly<Record<string, string>>,
  cellSize: number,
): Graphics {
  const marks = new Graphics()
  const spec = HEARTHSIDE_STYLE.terrain.reedMarks
  if (spec.perCell === 0 || spec.opacity <= 0) return marks
  const color = HEARTHSIDE_STYLE.palette[spec.tint]
  const [minimumLength, maximumLength] = spec.lengthCells
  for (const [row, line] of rows.entries()) {
    for (let column = 0; column < line.length; column += 1) {
      if (groundNameForCode[line[column] ?? ''] !== 'reeds') continue
      for (let mark = 0; mark < spec.perCell; mark += 1) {
        const unit = (part: string): number =>
          terrainHash('reed-mark', part, column, row, mark) / 0xffffffff
        const x = column + 0.12 + 0.76 * unit('x')
        const y = row + 0.12 + 0.76 * unit('y')
        const length = minimumLength + (maximumLength - minimumLength) * unit('length')
        const angle = -Math.PI / 2 + (unit('angle') - 0.5) * 0.9
        const dx = (Math.cos(angle) * length) / 2
        const dy = (Math.sin(angle) * length) / 2
        marks
          .moveTo((x - dx) * cellSize, (y - dy) * cellSize)
          .lineTo((x + dx) * cellSize, (y + dy) * cellSize)
          .stroke({
            color,
            width: spec.widthCells * cellSize,
            alpha: spec.opacity,
            cap: 'round',
          })
      }
    }
  }
  return marks
}

/** Offset run points along the chain's left normal, negative offsets landing on the right. */
export function offsetPolyline(
  points: readonly TerrainContourPoint[],
  offsetCells: number,
): readonly ContourCoordinate[] {
  return points.map((point, index) => {
    const before = points[Math.max(0, index - 1)] ?? point
    const after = points[Math.min(points.length - 1, index + 1)] ?? point
    const dx = after.x - before.x
    const dy = after.y - before.y
    const length = Math.hypot(dx, dy)
    if (length <= 1e-9) return { x: point.x, y: point.y }
    return { x: point.x + (-dy / length) * offsetCells, y: point.y + (dx / length) * offsetCells }
  })
}

/** Keep building interiors, thresholds, and walls as exact square texture cells. */
export function exactTerrainGrid(
  rows: readonly string[],
  groundNameForCode: Readonly<Record<string, string>>,
  names: readonly string[],
): TileGrid {
  const columns = rows[0]?.length ?? 0
  if (columns === 0 || rows.some((row) => row.length !== columns)) {
    throw new Error('Exact terrain coverage requires a non-empty rectangular ground grid.')
  }
  const accepted = new Set(names)
  return {
    columns,
    rows: rows.map((row) =>
      [...row].map((code) => (accepted.has(groundNameForCode[code] ?? '') ? code : ' ')).join(''),
    ),
  }
}

/** A route surface strokes with its repeating pattern; the seam cover strokes plain white. */
type RouteFill = FillPattern | string

function routeStroke(fill: RouteFill, width: number): Parameters<Graphics['stroke']>[0] {
  const base = { width, cap: 'round', join: 'round' } as const
  return typeof fill === 'string' ? { ...base, color: fill } : { ...base, fill }
}

/** Stroke every canonical path chain with the path pattern, including road-contact extensions. */
export function pathGuideGraphics(
  routes: TerrainRoutePlan,
  cellSize: number,
  fill: RouteFill,
): Graphics {
  const path = new Graphics()
  appendPathGuides(path, routes, cellSize, fill)
  return path
}

/** Stroke the inset road guide with the road pattern. The caller flattens its composite alpha. */
export function roadGuideGraphics(
  routes: TerrainRoutePlan,
  cellSize: number,
  fill: RouteFill,
): Graphics {
  const road = new Graphics()
  appendRoadGuide(road, routes, cellSize, fill)
  return road
}

/** White coverage of the road, every path, and every bridge deck, cutting seams under routes. */
export function routeCoverGraphics(routes: TerrainRoutePlan, cellSize: number): Graphics {
  const cover = new Graphics()
  appendRoadGuide(cover, routes, cellSize, '#ffffff')
  appendPathGuides(cover, routes, cellSize, '#ffffff')
  appendBridgeDecks(cover, routes.bridgeComponents, cellSize)
  return cover
}

function appendPathGuides(
  target: Graphics,
  routes: TerrainRoutePlan,
  cellSize: number,
  fill: RouteFill,
): void {
  for (const guide of routes.pathGuides) {
    const first = guide.points[0]
    if (first === undefined) continue
    if (guide.points.length === 1) {
      target
        .circle(first.x * cellSize, first.y * cellSize, (guide.widthCells * cellSize) / 2)
        .fill(fill)
      continue
    }
    target.moveTo(first.x * cellSize, first.y * cellSize)
    for (const point of guide.points.slice(1)) {
      target.lineTo(point.x * cellSize, point.y * cellSize)
    }
    if (guide.closed) target.closePath()
    target.stroke(routeStroke(fill, guide.widthCells * cellSize))
  }
}

function appendRoadGuide(
  target: Graphics,
  routes: TerrainRoutePlan,
  cellSize: number,
  fill: RouteFill,
): void {
  for (let index = 1; index < routes.roadGuide.length; index += 1) {
    const previous = routes.roadGuide[index - 1]
    const point = routes.roadGuide[index]
    if (previous === undefined || point === undefined) continue
    target
      .moveTo(previous.x * cellSize, previous.y * cellSize)
      .lineTo(point.x * cellSize, point.y * cellSize)
      .stroke(routeStroke(fill, Math.min(previous.widthCells, point.widthCells) * cellSize))
  }
  for (const point of routes.roadGuide) {
    target
      .circle(point.x * cellSize, point.y * cellSize, (point.widthCells * cellSize) / 2)
      .fill(fill)
  }
}

/** Clip repeated plank tiles to one route-width deck for each bridge component. */
export function bridgeDeckMask(
  components: readonly TerrainBridgeComponent[],
  cellSize: number,
): Graphics {
  const mask = new Graphics()
  appendBridgeDecks(mask, components, cellSize)
  return mask
}

function appendBridgeDecks(
  target: Graphics,
  components: readonly TerrainBridgeComponent[],
  cellSize: number,
): void {
  for (const component of components) {
    const { deck } = component
    if (deck.kind === 'compact') {
      if (component.cells.length > 1) {
        for (const cell of component.cells) {
          target
            .rect(cell.column * cellSize, cell.row * cellSize, cellSize, cellSize)
            .fill('#ffffff')
        }
        continue
      }
      const size = deck.widthCells * cellSize
      target
        .roundRect(
          deck.center.x * cellSize - size / 2,
          deck.center.y * cellSize - size / 2,
          size,
          size,
          size / 4,
        )
        .fill('#ffffff')
      continue
    }
    const axis = deck.axis
    if (axis === undefined) throw new Error(`Bridge component ${component.id} has no deck axis.`)
    target
      .moveTo(axis[0].x * cellSize, axis[0].y * cellSize)
      .lineTo(axis[1].x * cellSize, axis[1].y * cellSize)
      .stroke({
        color: '#ffffff',
        width: deck.widthCells * cellSize,
        cap: 'square',
        join: 'round',
      })
  }
}

/** Split one seam into deterministic visible arc intervals with shoreline taper alpha. */
export function seamStrokeRuns(
  chain: Pick<TerrainContourChain, 'id' | 'closed' | 'points' | 'rawLength' | 'shorelineSpans'>,
  spec: {
    readonly opacity: number
    readonly density: number
    readonly runLengthCells: readonly [number, number]
  },
  tag: string,
): readonly SeamStrokeRun[] {
  const runs: SeamStrokeRun[] = []
  if (chain.points.length < 2 || chain.rawLength <= 0 || spec.density <= 0) return runs
  const [minimumRun, maximumRun] = spec.runLengthCells
  const averageRun = (minimumRun + maximumRun) / 2
  const cycleLength = averageRun / Math.min(1, spec.density)
  const phase = hashUnit(terrainHash(`${tag}-phase`, chain.id)) * cycleLength
  const firstCycle = Math.floor(phase / cycleLength) - 1
  const lastCycle = Math.ceil((chain.rawLength + phase) / cycleLength)
  const tapered = chain.shorelineSpans.length > 0
  for (let cycle = firstCycle; cycle <= lastCycle; cycle += 1) {
    const runLength =
      minimumRun + hashUnit(terrainHash(`${tag}-run`, chain.id, cycle)) * (maximumRun - minimumRun)
    const cycleStart = cycle * cycleLength - phase
    const startOffset = Math.max(0, cycleStart)
    const endOffset = Math.min(chain.rawLength, cycleStart + runLength)
    if (endOffset - startOffset <= 1e-9) continue
    appendTaperedRuns(runs, chain, startOffset, endOffset, spec.opacity, tapered)
  }
  return runs
}

function appendTaperedRuns(
  result: SeamStrokeRun[],
  chain: Pick<TerrainContourChain, 'closed' | 'points' | 'rawLength'>,
  startOffset: number,
  endOffset: number,
  opacity: number,
  tapered: boolean,
): void {
  const points = pointsForArcInterval(chain, startOffset, endOffset)
  const factorOf = (point: TerrainContourPoint): number => (tapered ? point.shorelineFactor : 1)
  let active: TerrainContourPoint[] | undefined
  let activeAlpha = 0
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]
    const end = points[index]
    if (start === undefined || end === undefined) continue
    const alpha = opacity * Math.min(factorOf(start), factorOf(end))
    if (alpha <= 0) {
      if (active !== undefined) result.push({ points: active, alpha: activeAlpha, closed: false })
      active = undefined
      continue
    }
    if (active === undefined || Math.abs(activeAlpha - alpha) > 1e-9) {
      if (active !== undefined) result.push({ points: active, alpha: activeAlpha, closed: false })
      active = [start, end]
      activeAlpha = alpha
    } else {
      active.push(end)
    }
  }
  if (active !== undefined) result.push({ points: active, alpha: activeAlpha, closed: false })
}

function pointsForArcInterval(
  chain: Pick<TerrainContourChain, 'closed' | 'points' | 'rawLength'>,
  startOffset: number,
  endOffset: number,
): TerrainContourPoint[] {
  const result = [pointAtRawOffset(chain, startOffset)]
  for (const point of chain.points) {
    if (point.rawOffset > startOffset + 1e-9 && point.rawOffset < endOffset - 1e-9) {
      result.push(point)
    }
  }
  result.push(pointAtRawOffset(chain, endOffset))
  return result
}

function pointAtRawOffset(
  chain: Pick<TerrainContourChain, 'closed' | 'points' | 'rawLength'>,
  offset: number,
): TerrainContourPoint {
  const pointCount = chain.points.length
  const segmentCount = chain.closed ? pointCount : pointCount - 1
  for (let index = 0; index < segmentCount; index += 1) {
    const start = chain.points[index]
    const end = chain.points[(index + 1) % pointCount]
    if (start === undefined || end === undefined) continue
    const endOffset = chain.closed && index === pointCount - 1 ? chain.rawLength : end.rawOffset
    if (offset < start.rawOffset - 1e-9 || offset > endOffset + 1e-9) continue
    const span = endOffset - start.rawOffset
    const amount = span <= 1e-9 ? 0 : (offset - start.rawOffset) / span
    return {
      x: start.x + (end.x - start.x) * amount,
      y: start.y + (end.y - start.y) * amount,
      rawOffset: offset,
      locked: start.locked && end.locked,
      shorelineFactor:
        start.shorelineFactor + (end.shorelineFactor - start.shorelineFactor) * amount,
    }
  }
  const fallback = chain.points.at(-1)
  if (fallback === undefined) throw new Error('Seam chain has no points.')
  return { ...fallback, rawOffset: offset }
}

function hashUnit(hash: number): number {
  return hash / 0xffffffff
}

/** Draw the configured ground as the unchanged dense, solid-color pre-art fallback. */
function drawFallbackMap(layer: Container, scene: StaticScene): TiledGround {
  const baseCode = scene.ground.find((item) => item.layer === 'base')?.code
  if (baseCode === undefined) throw new Error('Three Branches rules do not define a fill ground.')
  const rowsFor = (wanted: 'landscape' | 'structure'): string[] =>
    scene.topFirstRows.map((row) =>
      [...row].map((code) => (scene.groundByCode[code]?.layer === wanted ? code : ' ')).join(''),
    )
  const baseRows = scene.topFirstRows.map(() => baseCode.repeat(scene.village.size.cellsX))
  const colors = Object.fromEntries(scene.ground.map((ground) => [ground.code, ground.color]))
  const ground = createTiledGround(
    { columns: scene.village.size.cellsX, rows: baseRows },
    solidColorTileset(colors),
    {
      cellSize: THREE_BRANCHES_PRESENTATION.unitsPerMetre * scene.village.size.cellSize,
      layers: [
        { columns: scene.village.size.cellsX, rows: rowsFor('landscape') },
        { columns: scene.village.size.cellsX, rows: rowsFor('structure') },
      ],
    },
  )
  layer.addChild(ground.view)
  return ground
}

/** Draw only the configured wall ground into the layer that sits above characters. */
export function drawUpperWalls(layer: Container, scene: StaticScene, art: TerrainArt): TiledGround {
  const ground = createTiledGround(
    transparentUpperGrid(scene.village.size.cellsX, scene.village.size.cellsY),
    art.upperWallTileset,
    {
      cellSize: THREE_BRANCHES_PRESENTATION.unitsPerMetre * scene.village.size.cellSize,
      layers: [art.upperWallGrid],
      variant: art.upperWallVariant,
    },
  )
  layer.addChild(ground.view)
  return ground
}

/** Combine the planner's signed outer and direct-hole rings in one Pixi signed path. */
export function signedComponentPath(
  outer: TerrainContourRing,
  holes: readonly TerrainContourRing[],
  cellSize: number,
): GraphicsPath {
  const path = new GraphicsPath(undefined, true)
  appendRing(path, outer, cellSize)
  for (const hole of holes) appendRing(path, hole, cellSize)
  return path
}

function appendRing(path: GraphicsPath, ring: TerrainContourRing, cellSize: number): void {
  const first = ring.points[0]
  if (first === undefined) throw new Error(`Terrain ring ${ring.id} has no points.`)
  path.moveTo(first.x * cellSize, first.y * cellSize)
  for (const point of ring.points.slice(1)) path.lineTo(point.x * cellSize, point.y * cellSize)
  path.closePath()
}

export function ownedTerrainView(
  owner: Container,
  grounds: readonly GroundView[],
  graphics: readonly Graphics[],
  span: GroundView['span'],
): GroundView {
  let destroyed = false
  return {
    view: owner,
    span,
    destroy() {
      if (destroyed) return
      destroyed = true
      for (const ground of grounds) ground.destroy()
      for (const graphic of graphics) graphic.destroy()
      owner.destroy({ children: false })
    },
  }
}
