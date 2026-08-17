import { hashUnit, stableHashParts } from '@renderers/base/math.js'
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
import { pointToSegmentDistance } from './terrain-helpers.js'
import type {
  ContourCoordinate,
  StaticScene,
  TerrainBridgeComponent,
  TerrainContourChain,
  TerrainContourPlan,
  TerrainContourPoint,
  TerrainContourRing,
  TerrainRoutePlan,
} from './types.js'

/** The natural surface materials whose shared boundaries take the seam treatments. */
const NATURAL_SEAM_MATERIALS = new Set(['ground', 'field', 'reeds', 'water'])
const OVERLAY_MATERIALS = ['field', 'reeds', 'water'] as const
const STRUCTURE_NAMES = ['interior', 'doorway', 'wall'] as const
const ROUTE_EDGE_FADE_STEPS = 10

type SurfaceMaterial = (typeof OVERLAY_MATERIALS)[number] | 'road' | 'path'

/** One deterministic visible portion of a broken seam stroke along a contour chain. */
export interface SeamStrokeRun {
  readonly points: readonly TerrainContourPoint[]
  readonly alpha: number
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
    reedMarksGraphics(art.contours, art.routes.visualRows, names, cellSize),
    inkGraphics(art.contours, cellSize, fillPatternFor(art, 'ink', cellSize)),
    hatchGraphics(art.contours, cellSize),
  ] as const
  for (const seam of seams) seam.setMask?.({ mask: seamCover, inverse: true })
  add(seams[0], 'terrain-seam-pooling')
  add(seams[1], 'terrain-reed-marks')
  add(seams[2], 'terrain-seam-ink')
  add(seams[3], 'terrain-seam-hatch')
  add(seamCover, 'terrain-seam-cover')

  const pathTreatment = HEARTHSIDE_STYLE.terrain.routes.path
  const pathPattern = fillPatternFor(art, 'path', cellSize)
  const pathLayers = routeFadeLayers(
    'terrain-path',
    pathTreatment.edgeFadeCells,
    materialLayerAlpha('path'),
    (extraWidthCells) => pathGuideGraphics(art.routes, cellSize, pathPattern, extraWidthCells),
  )
  const pathBridgeCutout = bridgeDeckMask(
    art.routes.bridgeComponents,
    cellSize,
    pathTreatment.edgeFadeCells * 2,
  )
  pathLayers.view.setMask?.({ mask: pathBridgeCutout, inverse: true })
  owner.addChild(pathLayers.view, pathBridgeCutout)
  graphics.push(...pathLayers.graphics)
  pathBridgeCutout.label = 'terrain-path-bridge-cutout'
  graphics.push(pathBridgeCutout)

  const roadTreatment = HEARTHSIDE_STYLE.terrain.routes.road
  const roadPattern = fillPatternFor(art, 'road', cellSize)
  const roadLayers = routeFadeLayers(
    'terrain-road',
    roadTreatment.edgeFadeCells,
    materialLayerAlpha('road'),
    (extraWidthCells) => roadGuideGraphics(art.routes, cellSize, roadPattern, extraWidthCells),
  )
  const roadBridgeCutout = bridgeDeckMask(
    art.routes.bridgeComponents,
    cellSize,
    roadTreatment.edgeFadeCells * 2,
  )
  roadLayers.view.setMask?.({ mask: roadBridgeCutout, inverse: true })
  owner.addChild(roadLayers.view, roadBridgeCutout)
  graphics.push(...roadLayers.graphics)
  roadBridgeCutout.label = 'terrain-road-bridge-cutout'
  graphics.push(roadBridgeCutout)

  const structures = createSparseTiledGround(
    exactTerrainGrid(scene.topFirstRows, names, STRUCTURE_NAMES),
    art.tileset,
    { cellSize, variant: art.variant },
  )
  structures.view.label = 'terrain-structures'
  owner.addChild(structures.view)
  grounds.push(structures)

  const plankTreatment = HEARTHSIDE_STYLE.terrain.planks
  const plankShadow = bridgeDeckMask(art.routes.bridgeComponents, cellSize)
  plankShadow.tint = HEARTHSIDE_STYLE.palette[plankTreatment.shadowTint]
  plankShadow.alpha = plankTreatment.shadowOpacity
  plankShadow.y = plankTreatment.shadowOffsetCells * cellSize
  add(plankShadow, 'terrain-planks-shadow')

  const planks = createSparseTiledGround(art.plankLayer, art.tileset, {
    cellSize,
    variant: art.variant,
  })
  const deckClip = bridgeDeckMask(
    art.routes.bridgeComponents,
    cellSize,
    plankTreatment.textureBleedCells * 2,
  )
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

/** The outer ring and direct hole rings of every component of one material. */
function componentRings(
  plan: TerrainContourPlan,
  material: string,
): { readonly outer: TerrainContourRing; readonly holes: readonly TerrainContourRing[] }[] {
  const rings = new Map(plan.rings.map((ring) => [ring.id, ring]))
  const parts = []
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
    parts.push({ outer, holes })
  }
  return parts
}

/** One signed path per component of the material, including only its direct hole rings. */
export function componentPaths(
  plan: TerrainContourPlan,
  material: string,
  cellSize: number,
): GraphicsPath[] {
  return componentRings(plan, material).map(({ outer, holes }) =>
    signedComponentPath(outer, holes, cellSize),
  )
}

/**
 * A containment test for the drawn surface of one material, in cell coordinates.
 *
 * Decoration scattered by cell has to ask this before it draws. The cell grid and the contour
 * surface only agree where the boundary runs along a cell edge, so anything placed by cell alone
 * spills over the boundary wherever it runs at an angle, and its own edge redraws exactly the
 * staircase the contour pass exists to remove.
 */
export function materialSurface(
  plan: TerrainContourPlan,
  material: string,
): (x: number, y: number) => boolean {
  const parts = componentRings(plan, material).map(({ outer, holes }) => ({
    bounds: ringBounds(outer.points),
    outer: outer.points,
    holes: holes.map((hole) => hole.points),
  }))
  return (x, y) =>
    parts.some(
      ({ bounds, outer, holes }) =>
        x >= bounds.left &&
        x <= bounds.right &&
        y >= bounds.top &&
        y <= bounds.bottom &&
        ringContains(outer, x, y) &&
        !holes.some((hole) => ringContains(hole, x, y)),
    )
}

function ringBounds(points: readonly ContourCoordinate[]): {
  left: number
  right: number
  top: number
  bottom: number
} {
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  }
}

/** Crossing count of a ray cast from the point, odd meaning the ring encloses it. */
function ringContains(ring: readonly ContourCoordinate[], x: number, y: number): boolean {
  let enclosed = false
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const corner = ring[index]!
    const before = ring[previous]!
    if (corner.y > y === before.y > y) continue
    const crossing = ((before.x - corner.x) * (y - corner.y)) / (before.y - corner.y) + corner.x
    if (x < crossing) enclosed = !enclosed
  }
  return enclosed
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
    const widthUnit = hashUnit(stableHashParts('seam-ink-body', chainId, bucket))
    const toneUnit = hashUnit(stableHashParts('seam-ink-tone', chainId, bucket))
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
        for (const line of offsetPolyline(run.points, sign * offsetCells)) {
          hatch.moveTo(line[0]!.x * cellSize, line[0]!.y * cellSize)
          for (const point of line.slice(1)) {
            hatch.lineTo(point.x * cellSize, point.y * cellSize)
          }
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
  }
  return hatch
}

/**
 * Scatter deterministic short stalk strokes across the reed surface. The marks carry the reed
 * texture until a bolder authored reed frame pass lands in the atlas.
 *
 * The scatter walks cells, since that is what makes it deterministic and evenly dense, but the
 * reed surface is the smooth contour polygon rather than the cells it was quantized from. Every
 * mark is placed by cell and then kept only if it lands on that surface, so the stalks stop where
 * the drawn bank stops instead of drawing the cell staircase back over it.
 */
export function reedMarksGraphics(
  plan: TerrainContourPlan,
  rows: readonly string[],
  groundNameForCode: Readonly<Record<string, string>>,
  cellSize: number,
): Graphics {
  const marks = new Graphics()
  const spec = HEARTHSIDE_STYLE.terrain.reedMarks
  if (spec.perCell === 0 || spec.opacity <= 0) return marks
  const color = HEARTHSIDE_STYLE.palette[spec.tint]
  const [minimumLength, maximumLength] = spec.lengthCells
  const onReeds = materialSurface(plan, 'reeds')
  for (const [row, line] of rows.entries()) {
    for (let column = 0; column < line.length; column += 1) {
      // Cells the surface reaches without being reed cells carry marks too, so the stalks follow
      // the boundary outward as well as inward.
      const reedCell = groundNameForCode[line[column] ?? ''] === 'reeds'
      if (!reedCell && !onReeds(column + 0.5, row + 0.5)) continue
      for (let mark = 0; mark < spec.perCell; mark += 1) {
        const unit = (part: string): number =>
          hashUnit(stableHashParts('reed-mark', part, column, row, mark))
        const x = column + 0.12 + 0.76 * unit('x')
        const y = row + 0.12 + 0.76 * unit('y')
        if (!onReeds(x, y)) continue
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

/** Corners whose miter runs longer than this many offsets are bevelled instead of spiked. */
const OFFSET_MITER_LIMIT = 2
/**
 * How far inside its own offset a point may sit before it counts as folded, in cells. The source
 * is a sampled curve, so its chords sag under the arc they stand for and the check needs that much
 * slack. A fold shallower than this needs the bank to bend within a rounding of the offset itself.
 */
const OFFSET_FOLD_SLACK_CELLS = 0.05

/** One offset point together with the source vertex it was raised from. */
interface OffsetPoint {
  readonly point: ContourCoordinate
  readonly at: number
}

/**
 * Offset run points along the chain's left normal, negative offsets landing on the right.
 *
 * Each source segment moves as a whole and consecutive offset segments meet where their lines
 * cross, so a corner keeps its full offset instead of being pulled back toward the bank. Where the
 * bank turns tighter than the offset, that meeting swings past the opposite branch and the line
 * folds into a bowtie, which strokes as a small dark triangle out on the water. Two rules undo
 * that: every point of a true offset stays the full offset away from its source, and a true offset
 * walks its source forward rather than back down it.
 *
 * What the two rules drop is where the offset has no room to exist, so the result comes back as
 * separate runs that stop at each gap. A single run joined across them instead, which reads as a
 * stroke drawn straight over the water wherever a whole inlet or headland went.
 */
export function offsetPolyline(
  points: readonly TerrainContourPoint[],
  offsetCells: number,
): readonly (readonly ContourCoordinate[])[] {
  const source = withoutRepeats(points)
  if (source.length < 2) return []
  const normals = source.slice(0, -1).map((start, index) => {
    const end = source[index + 1]!
    const length = Math.hypot(end.x - start.x, end.y - start.y)
    return { x: -(end.y - start.y) / length, y: (end.x - start.x) / length }
  })
  const moved: OffsetPoint[] = []
  for (const [at, vertex] of source.entries()) {
    const before = normals[Math.max(0, at - 1)]!
    const after = normals[Math.min(normals.length - 1, at)]!
    const spread = 1 + before.x * after.x + before.y * after.y
    const miter = { x: (before.x + after.x) / spread, y: (before.y + after.y) / spread }
    if (spread > 0 && Math.hypot(miter.x, miter.y) <= OFFSET_MITER_LIMIT) {
      moved.push({ at, point: displace(vertex, miter, offsetCells) })
      continue
    }
    moved.push(
      { at, point: displace(vertex, before, offsetCells) },
      { at, point: displace(vertex, after, offsetCells) },
    )
  }
  const clear = withoutFolds(moved, source, Math.abs(offsetCells))
  return intoRuns(onlyAdvancing(clear, source))
}

/** Cut the survivors into runs at the source vertices whose offset points were dropped. */
function intoRuns(kept: readonly OffsetPoint[]): readonly (readonly ContourCoordinate[])[] {
  const runs: ContourCoordinate[][] = []
  let current: ContourCoordinate[] = []
  let previous: OffsetPoint | undefined
  for (const offsetPoint of kept) {
    if (previous !== undefined && offsetPoint.at - previous.at > 1) {
      runs.push(current)
      current = []
    }
    current.push(offsetPoint.point)
    previous = offsetPoint
  }
  runs.push(current)
  return runs.filter((run) => run.length > 1)
}

function displace(
  vertex: ContourCoordinate,
  direction: ContourCoordinate,
  offsetCells: number,
): ContourCoordinate {
  return { x: vertex.x + direction.x * offsetCells, y: vertex.y + direction.y * offsetCells }
}

/**
 * Drop the points a fold shallower than the slack leaves behind. Inside a fold the offset doubles
 * back, so a step that runs against the source it was raised from belongs to one.
 */
function onlyAdvancing(
  moved: readonly OffsetPoint[],
  source: readonly ContourCoordinate[],
): OffsetPoint[] {
  const kept: OffsetPoint[] = []
  for (const candidate of moved) {
    const last = kept.at(-1)
    if (last !== undefined && last.at !== candidate.at) {
      const alongSource = {
        x: source[candidate.at]!.x - source[last.at]!.x,
        y: source[candidate.at]!.y - source[last.at]!.y,
      }
      const alongOffset = {
        x: candidate.point.x - last.point.x,
        y: candidate.point.y - last.point.y,
      }
      if (alongOffset.x * alongSource.x + alongOffset.y * alongSource.y <= 0) continue
    }
    kept.push(candidate)
  }
  return kept
}

/** The run without the repeated points a taper split or an arc interval can leave behind. */
function withoutRepeats(points: readonly TerrainContourPoint[]): ContourCoordinate[] {
  const result: ContourCoordinate[] = []
  for (const point of points) {
    const last = result.at(-1)
    if (last !== undefined && Math.hypot(point.x - last.x, point.y - last.y) <= 1e-9) continue
    result.push({ x: point.x, y: point.y })
  }
  return result
}

/**
 * Drop the offset points that ended up nearer their source than the offset they were given. Only
 * source segments within one offset of a point can rule it out, so the segments are bucketed at
 * that size and each point measures the nine buckets its own disc reaches.
 */
function withoutFolds(
  moved: readonly OffsetPoint[],
  source: readonly ContourCoordinate[],
  offset: number,
): OffsetPoint[] {
  const size = Math.max(offset, 1e-6)
  const buckets = new Map<string, number[]>()
  const spanKeys = (low: number, high: number): number[] => {
    const keys: number[] = []
    for (let key = Math.floor(low / size); key <= Math.floor(high / size); key += 1) keys.push(key)
    return keys
  }
  for (let index = 0; index + 1 < source.length; index += 1) {
    const start = source[index]!
    const end = source[index + 1]!
    for (const y of spanKeys(Math.min(start.y, end.y), Math.max(start.y, end.y))) {
      for (const x of spanKeys(Math.min(start.x, end.x), Math.max(start.x, end.x))) {
        const bucket = buckets.get(`${x}:${y}`) ?? []
        bucket.push(index)
        buckets.set(`${x}:${y}`, bucket)
      }
    }
  }
  const kept: OffsetPoint[] = []
  for (const offsetPoint of moved) {
    const { point } = offsetPoint
    let nearest = Number.POSITIVE_INFINITY
    for (const y of spanKeys(point.y - offset, point.y + offset)) {
      for (const x of spanKeys(point.x - offset, point.x + offset)) {
        for (const index of buckets.get(`${x}:${y}`) ?? []) {
          nearest = Math.min(
            nearest,
            pointToSegmentDistance(point, source[index]!, source[index + 1]!),
          )
        }
      }
    }
    if (nearest >= offset - OFFSET_FOLD_SLACK_CELLS) kept.push(offsetPoint)
  }
  return kept
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
  extraWidthCells = 0,
): Graphics {
  const path = new Graphics()
  appendPathGuides(path, routes, cellSize, fill, extraWidthCells)
  return path
}

/** Stroke the inset road guide with the road pattern. The caller flattens its composite alpha. */
export function roadGuideGraphics(
  routes: TerrainRoutePlan,
  cellSize: number,
  fill: RouteFill,
  extraWidthCells = 0,
): Graphics {
  const road = new Graphics()
  appendRoadGuide(road, routes, cellSize, fill, extraWidthCells)
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
  extraWidthCells = 0,
): void {
  for (const guide of routes.pathGuides) {
    const first = guide.points[0]
    if (first === undefined) continue
    if (guide.points.length === 1) {
      target
        .circle(
          first.x * cellSize,
          first.y * cellSize,
          ((guide.widthCells + extraWidthCells) * cellSize) / 2,
        )
        .fill(fill)
      continue
    }
    target.moveTo(first.x * cellSize, first.y * cellSize)
    for (const point of guide.points.slice(1)) {
      target.lineTo(point.x * cellSize, point.y * cellSize)
    }
    if (guide.closed) target.closePath()
    target.stroke(routeStroke(fill, (guide.widthCells + extraWidthCells) * cellSize))
  }
}

interface RouteFadeLayers {
  readonly view: Container
  readonly graphics: readonly Graphics[]
}

/** Draw one route surface from concentric layers whose composite alpha rises linearly inward. */
function routeFadeLayers(
  label: string,
  edgeFadeCells: number,
  opacity: number,
  drawLayer: (extraWidthCells: number) => Graphics,
): RouteFadeLayers {
  const view = new Container()
  const graphics: Graphics[] = []
  view.label = label
  let previousComposite = 0
  for (let step = 0; step < ROUTE_EDGE_FADE_STEPS; step += 1) {
    const targetComposite = (opacity * (step + 1)) / ROUTE_EDGE_FADE_STEPS
    const layerOpacity = (targetComposite - previousComposite) / (1 - previousComposite)
    const extraWidthCells =
      2 * edgeFadeCells * (1 - (2 * step) / (ROUTE_EDGE_FADE_STEPS - 1))
    const layer = drawLayer(extraWidthCells)
    layer.filters = [new AlphaFilter({ alpha: layerOpacity })]
    layer.label = `${label}-fade-${step}`
    view.addChild(layer)
    graphics.push(layer)
    previousComposite = targetComposite
  }
  return { view, graphics }
}

function appendRoadGuide(
  target: Graphics,
  routes: TerrainRoutePlan,
  cellSize: number,
  fill: RouteFill,
  extraWidthCells = 0,
): void {
  for (let index = 1; index < routes.roadGuide.length; index += 1) {
    const previous = routes.roadGuide[index - 1]
    const point = routes.roadGuide[index]
    if (previous === undefined || point === undefined) continue
    target
      .moveTo(previous.x * cellSize, previous.y * cellSize)
      .lineTo(point.x * cellSize, point.y * cellSize)
      .stroke(
        routeStroke(fill, (Math.min(previous.widthCells, point.widthCells) + extraWidthCells) * cellSize),
      )
  }
  for (const point of routes.roadGuide) {
    target
      .circle(point.x * cellSize, point.y * cellSize, ((point.widthCells + extraWidthCells) * cellSize) / 2)
      .fill(fill)
  }
}

/** Clip repeated plank tiles to one route-width deck for each bridge component. */
export function bridgeDeckMask(
  components: readonly TerrainBridgeComponent[],
  cellSize: number,
  extraWidthCells = 0,
): Graphics {
  const mask = new Graphics()
  appendBridgeDecks(mask, components, cellSize, extraWidthCells)
  return mask
}

function appendBridgeDecks(
  target: Graphics,
  components: readonly TerrainBridgeComponent[],
  cellSize: number,
  extraWidthCells = 0,
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
        width: (deck.widthCells + extraWidthCells) * cellSize,
        cap: deck.cap,
        join: 'round',
      })
  }
}

/**
 * Split one seam into deterministic visible arc intervals with shoreline taper alpha.
 *
 * Runs and gaps alternate, each drawn from its own configured range, so no stretch of boundary
 * longer than one gap ever goes undrawn and runs never overlap into a doubled stroke. A chain
 * shorter than the shortest run is drawn whole, since a hand-drawn line does not skip a bank for
 * being short.
 */
export function seamStrokeRuns(
  chain: Pick<TerrainContourChain, 'id' | 'closed' | 'points' | 'rawLength' | 'shorelineSpans'>,
  spec: {
    readonly opacity: number
    readonly runLengthCells: readonly [number, number]
    readonly gapLengthCells: readonly [number, number]
  },
  tag: string,
): readonly SeamStrokeRun[] {
  const runs: SeamStrokeRun[] = []
  if (chain.points.length < 2 || chain.rawLength <= 0) return runs
  const tapered = chain.shorelineSpans.length > 0
  const pick = (range: readonly [number, number], role: string, index: number): number =>
    range[0] + hashUnit(stableHashParts(`${tag}-${role}`, chain.id, index)) * (range[1] - range[0])
  if (chain.rawLength <= spec.runLengthCells[0]) {
    appendTaperedRuns(runs, chain, 0, chain.rawLength, spec.opacity, tapered)
    return runs
  }
  // The phase spans one whole run and gap, so where a chain falls in the pattern varies with its
  // id instead of every chain starting mid-stroke at its first point.
  let offset = -pick([0, spec.runLengthCells[1] + spec.gapLengthCells[1]], 'phase', 0)
  for (let index = 0; offset < chain.rawLength; index += 1) {
    const runLength = pick(spec.runLengthCells, 'run', index)
    const startOffset = Math.max(0, offset)
    const endOffset = Math.min(chain.rawLength, offset + runLength)
    if (endOffset - startOffset > 1e-9) {
      appendTaperedRuns(runs, chain, startOffset, endOffset, spec.opacity, tapered)
    }
    offset += runLength + pick(spec.gapLengthCells, 'gap', index)
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
      if (active !== undefined) result.push({ points: active, alpha: activeAlpha })
      active = undefined
      continue
    }
    if (active === undefined || Math.abs(activeAlpha - alpha) > 1e-9) {
      if (active !== undefined) result.push({ points: active, alpha: activeAlpha })
      active = [start, end]
      activeAlpha = alpha
    } else {
      active.push(end)
    }
  }
  if (active !== undefined) result.push({ points: active, alpha: activeAlpha })
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
