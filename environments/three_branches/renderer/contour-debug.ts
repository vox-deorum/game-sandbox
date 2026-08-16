/**
 * A developer view of the terrain contour pipeline: plan one village, draw every stage of its
 * geometry into one SVG, and report the measurements that say whether a boundary reads as drawn.
 *
 * Run it through `plans/days-at-three-branches/tools/contours.py`, which builds the village and
 * hands the rows over. Judging a contour needs the picture and the numbers together: an aggregate
 * can improve while the boundary on screen gets worse, and the layers here tell the two apart.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { RULES } from './overlay.js'
import { HEARTHSIDE_STYLE } from './presentation.js'
import { findCurveCrossings, maxCurveTubeDeviation } from './terrain-contour-validation.js'
import { planTerrainContours } from './terrain-contours.js'
import { planTerrainRoutes } from './terrain-routes.js'
import type {
  ContourCoordinate,
  TerrainContourChain,
  TerrainContourPlan,
  TerrainRoutePlan,
} from './types.js'

/** How far along the curve a turn is measured, in cells. Shorter reads noise, longer reads shape. */
const TURN_REACH_CELLS = 0.4

/** Turn angle, in degrees, past which a sample is marked as a hot spot. */
const HOT_TURN_DEGREES = 45

/** What the drawn geometry measures out at, all of it over free samples of unlocked chains. */
export interface ContourMeasurements {
  readonly chains: number
  readonly referenceVertices: number
  /** Reference vertices sitting exactly on a raw cell corner, where a staircase survived. */
  readonly onCellCorner: number
  readonly turnsPast45: number
  readonly turnsPast60: number
  /** Total turning divided by drawn length: how hard the boundary works to get where it goes. */
  readonly turningPerCell: number
  /** Direction reversals per ten cells: what a terraced boundary has and a drawn one does not. */
  readonly reversalsPerTenCells: number
  readonly wanderMedian: number
  readonly wanderP90: number
  readonly worstTubeCells: number
  readonly crossings: number
  readonly planMs: number
}

/** One drawn sample that turns harder than the hot-spot threshold. */
export interface HotSpot {
  readonly at: ContourCoordinate
  readonly degrees: number
}

/** Everything one run of the pipeline produced, ready to draw or assert on. */
export interface ContourDebugScene {
  readonly rows: readonly string[]
  readonly plan: TerrainContourPlan
  readonly routes: TerrainRoutePlan
  readonly measurements: ContourMeasurements
  readonly hotSpots: readonly HotSpot[]
  readonly crossingsAt: readonly ContourCoordinate[]
}

/** Ground code to material name, from the same table the runtime validates recordings against. */
export function materialNames(): Readonly<Record<string, string>> {
  return Object.fromEntries(RULES.grounds.map((ground) => [ground.code, ground.name]))
}

/**
 * Plan one village the way the game does and measure what it drew.
 *
 * The order matters and is the whole reason this exists: routes are planned first and contours run
 * on the rows they leave behind, where road and path cells have taken natural substrate. Contouring
 * the rows as authored sweeps a map the game never draws.
 */
export function contourDebugScene(rows: readonly string[]): ContourDebugScene {
  const names = materialNames()
  const routes = planTerrainRoutes(rows, names, HEARTHSIDE_STYLE.terrain.routes)
  const startedAt = performance.now()
  const plan = planTerrainContours(
    routes.visualRows,
    names,
    HEARTHSIDE_STYLE.terrain.contours,
    HEARTHSIDE_STYLE.terrain.seams.waterHatch.bridgeTaperCells,
  )
  const planMs = performance.now() - startedAt

  const hotSpots: HotSpot[] = []
  const wanders: number[] = []
  let referenceVertices = 0
  let onCellCorner = 0
  let turnsPast45 = 0
  let turnsPast60 = 0
  let turning = 0
  let drawnLength = 0
  let reversals = 0
  let measured = 0

  for (const chain of plan.chains) {
    if (chain.points.every((point) => point.locked)) continue
    measured += 1
    for (const point of chain.referencePoints) {
      referenceVertices += 1
      if (onLatticeCorner(point)) onCellCorner += 1
    }
    const points = closedPoints(chain)
    if (points.length < 6) continue
    const reference = chain.closed
      ? [...chain.referencePoints, chain.referencePoints[0]!]
      : chain.referencePoints

    let previousTurn = 0
    for (let index = 1; index < points.length - 1; index += 1) {
      const turn = turnBetween(points[index - 1]!, points[index]!, points[index + 1]!)
      turning += Math.abs(turn)
      drawnLength += distanceBetween(points[index - 1]!, points[index]!)
      if (previousTurn * turn < 0 && Math.abs(turn) > 0.01) reversals += 1
      previousTurn = turn
    }

    const offsets = arcOffsets(points)
    for (const [index, point] of points.entries()) {
      if (chain.points[index]?.locked === true) continue
      const before = reach(offsets, index, -TURN_REACH_CELLS)
      const after = reach(offsets, index, TURN_REACH_CELLS)
      if (before < 0 || after < 0) continue
      const degrees = Math.abs(
        (turnBetween(points[before]!, point, points[after]!) * 180) / Math.PI,
      )
      if (degrees > 45) turnsPast45 += 1
      if (degrees > 60) turnsPast60 += 1
      if (degrees > HOT_TURN_DEGREES) hotSpots.push({ at: { x: point.x, y: point.y }, degrees })
    }
    for (const point of chain.points) {
      if (point.locked) continue
      wanders.push(distanceToPolyline(point, reference))
    }
  }

  wanders.sort((first, second) => first - second)
  const quantile = (fraction: number): number =>
    wanders.length === 0 ? 0 : wanders[Math.floor((wanders.length - 1) * fraction)]!
  const crossings = findCurveCrossings(plan.chains)
  const tube = maxCurveTubeDeviation(plan.chains)

  return {
    rows: routes.visualRows,
    plan,
    routes,
    hotSpots,
    crossingsAt: crossings.map(([piece]) => ({ x: piece.start.x, y: piece.start.y })),
    measurements: {
      chains: measured,
      referenceVertices,
      onCellCorner,
      turnsPast45,
      turnsPast60,
      turningPerCell: drawnLength === 0 ? 0 : (turning * 180) / Math.PI / drawnLength,
      reversalsPerTenCells: drawnLength === 0 ? 0 : (reversals / drawnLength) * 10,
      wanderMedian: quantile(0.5),
      wanderP90: quantile(0.9),
      worstTubeCells: tube.cells,
      crossings: crossings.length,
      planMs,
    },
  }
}

/**
 * Turn recorded rows into the order the renderer draws them.
 *
 * The recording and the generator both keep their rows south first, and `buildStaticScene` in
 * `scene.ts` performs the sole inversion before anything is drawn. Doing it here, by the same
 * rule, is what keeps a drawing comparable with a screenshot of the running game: geometry laid
 * over a mirrored grid is self-consistent enough to reason from and still be wrong.
 */
export function topFirstRows(southFirstRows: readonly string[]): readonly string[] {
  return [...southFirstRows].reverse()
}

/** Window of the map to draw, in cells, and how many pixels one cell takes. */
export interface SvgOptions {
  readonly x: number
  readonly y: number
  readonly span: number
  readonly scale: number
  readonly seed: number
}

const LAYER_STYLE = `
  .cells rect { stroke: none }
  .grid { stroke: #00000014; stroke-width: 0.02 }
  .raw { fill: none; stroke: #1c3f6e; stroke-width: 0.03; opacity: 0.45 }
  .reference { fill: none; stroke: #b0402e; stroke-width: 0.04; opacity: 0.85 }
  .reference circle { fill: #b0402e; stroke: none }
  .reference circle.locked { fill: #27436b }
  .routes { fill: none; stroke: #8a6246; opacity: 0.35; stroke-linecap: round;
    stroke-linejoin: round }
  .drawn { fill: none; stroke: #2a2721; stroke-width: 0.15; stroke-linecap: round;
    stroke-linejoin: round }
  .hot circle { fill: none; stroke: #d9a441; stroke-width: 0.05 }
  .hot circle.crossing { stroke: #b0402e; stroke-width: 0.08 }
  .report text { font-family: ui-monospace, monospace; fill: #2a2721 }
  .report rect { fill: #efe7d3 }
`

/** Draw one planned village into a standalone SVG whose layers can be hidden one line at a time. */
export function contourSvg(scene: ContourDebugScene, options: SvgOptions): string {
  const { x, y, span, scale } = options
  const size = span * scale
  const visible = (point: ContourCoordinate): boolean =>
    point.x >= x - 2 && point.x <= x + span + 2 && point.y >= y - 2 && point.y <= y + span + 2
  const path = (points: readonly ContourCoordinate[], closed: boolean): string => {
    if (points.length === 0 || !points.some(visible)) return ''
    const drawn = points.map((point) => `${round(point.x)},${round(point.y)}`).join(' L')
    return `<path d="M${drawn}${closed ? ' Z' : ''}"/>`
  }

  const cells: string[] = []
  for (let row = Math.floor(y); row < y + span; row += 1) {
    for (let column = Math.floor(x); column < x + span; column += 1) {
      const code = scene.rows[row]?.charAt(column)
      if (code === undefined || code === '') continue
      cells.push(`<rect x="${column}" y="${row}" width="1" height="1" fill="${cellColor(code)}"/>`)
    }
  }
  const grid: string[] = []
  for (let line = Math.floor(x); line <= x + span; line += 1) {
    grid.push(`<path d="M${line},${round(y)} L${line},${round(y + span)}"/>`)
  }
  for (let line = Math.floor(y); line <= y + span; line += 1) {
    grid.push(`<path d="M${round(x)},${line} L${round(x + span)},${line}"/>`)
  }

  const raw: string[] = []
  const reference: string[] = []
  const drawn: string[] = []
  for (const chain of scene.plan.chains) {
    raw.push(path(chain.rawPoints, false))
    reference.push(path(closedPolyline(chain.referencePoints, chain.closed), chain.closed))
    drawn.push(path(closedPoints(chain), false))
    for (const [index, point] of chain.referencePoints.entries()) {
      if (!visible(point)) continue
      const locked = chain.points[index]?.locked === true ? ' class="locked"' : ''
      reference.push(`<circle cx="${round(point.x)}" cy="${round(point.y)}" r="0.06"${locked}/>`)
    }
  }

  const routes: string[] = [
    `<path d="M${scene.routes.roadGuide
      .map((point) => `${round(point.x)},${round(point.y)}`)
      .join(' L')}" stroke-width="${HEARTHSIDE_STYLE.terrain.routes.road.targetWidthCells}"/>`,
    ...scene.routes.pathGuides.map(
      (guide) =>
        `<path d="M${guide.points
          .map((point) => `${round(point.x)},${round(point.y)}`)
          .join(' L')}" stroke-width="${guide.widthCells}"/>`,
    ),
  ]

  const hot = [
    ...scene.hotSpots
      .filter((spot) => visible(spot.at))
      .map((spot) => `<circle cx="${round(spot.at.x)}" cy="${round(spot.at.y)}" r="0.3"/>`),
    ...scene.crossingsAt
      .filter(visible)
      .map((at) => `<circle cx="${round(at.x)}" cy="${round(at.y)}" r="0.45" class="crossing"/>`),
  ]

  // The report sits in a band above the map rather than over it, sized from its longest line so
  // it fits whatever window was asked for. A monospace glyph is a little over six tenths as wide
  // as it is tall.
  const lines = reportLines(scene.measurements, options)
  const longest = Math.max(...lines.map((line) => line.length))
  const font = span / (longest * 0.62 + 2)
  const band = font * (lines.length + 2) * 1.4
  const report = [
    `<rect x="${round(x)}" y="${round(y - band)}" width="${span}" height="${round(band)}"/>`,
    ...lines.map(
      (line, index) =>
        `<text x="${round(x + font)}" y="${round(y - band + font * (index + 1.6) * 1.4)}"` +
        ` font-size="${round(font)}">${line}</text>`,
    ),
  ]

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${round(size + band * scale)}"`,
    ` viewBox="${round(x)} ${round(y - band)} ${span} ${round(span + band)}">`,
    `<title>Three Branches contours, seed ${options.seed}</title>`,
    `<style>${LAYER_STYLE}</style>`,
    `<g class="cells">${cells.join('')}</g>`,
    `<g class="grid">${grid.join('')}</g>`,
    `<g class="routes">${routes.join('')}</g>`,
    `<g class="raw">${raw.join('')}</g>`,
    `<g class="reference">${reference.join('')}</g>`,
    `<g class="drawn">${drawn.join('')}</g>`,
    `<g class="hot">${hot.join('')}</g>`,
    `<g class="report">${report.join('')}</g>`,
    '</svg>',
    '',
  ].join('\n')
}

/** The measurements as lines of text, shown in the corner of the drawing and on the terminal. */
export function reportLines(
  measurements: ContourMeasurements,
  options: Pick<SvgOptions, 'seed'>,
): string[] {
  const share =
    measurements.referenceVertices === 0
      ? 0
      : (measurements.onCellCorner / measurements.referenceVertices) * 100
  return [
    `seed ${options.seed}, ${measurements.chains} free chains, planned in ` +
      `${measurements.planMs.toFixed(0)} ms`,
    `turns past 45 deg ${measurements.turnsPast45}, past 60 deg ${measurements.turnsPast60}`,
    `turning ${measurements.turningPerCell.toFixed(1)} deg per cell, reversals ` +
      `${measurements.reversalsPerTenCells.toFixed(2)} per 10 cells`,
    `wander from the reference: median ${measurements.wanderMedian.toFixed(3)}, p90 ` +
      `${measurements.wanderP90.toFixed(3)} cell`,
    `reference vertices ${measurements.referenceVertices}, on a raw cell corner ` +
      `${measurements.onCellCorner} (${share.toFixed(0)} percent)`,
    `worst tube deviation ${measurements.worstTubeCells.toFixed(3)} cell, crossings ` +
      `${measurements.crossings}`,
  ]
}

function cellColor(code: string): string {
  const palette = HEARTHSIDE_STYLE.palette
  const fill = HEARTHSIDE_STYLE.terrain.fills[materialNames()[code] ?? '']
  return fill === undefined ? palette.bone : palette[fill.tint]
}

function closedPolyline(
  points: readonly ContourCoordinate[],
  closed: boolean,
): readonly ContourCoordinate[] {
  return closed && points.length > 0 ? [...points, points[0]!] : points
}

function closedPoints(chain: TerrainContourChain): readonly ContourCoordinate[] {
  return closedPolyline(chain.points, chain.closed)
}

function onLatticeCorner(point: ContourCoordinate): boolean {
  return (
    Math.abs(point.x - Math.round(point.x)) < 1e-6 && Math.abs(point.y - Math.round(point.y)) < 1e-6
  )
}

function distanceBetween(first: ContourCoordinate, second: ContourCoordinate): number {
  return Math.hypot(second.x - first.x, second.y - first.y)
}

function turnBetween(
  before: ContourCoordinate,
  point: ContourCoordinate,
  after: ContourCoordinate,
): number {
  const inbound = Math.atan2(point.y - before.y, point.x - before.x)
  const outbound = Math.atan2(after.y - point.y, after.x - point.x)
  let turn = outbound - inbound
  while (turn > Math.PI) turn -= Math.PI * 2
  while (turn < -Math.PI) turn += Math.PI * 2
  return turn
}

function arcOffsets(points: readonly ContourCoordinate[]): number[] {
  const offsets = [0]
  for (let index = 1; index < points.length; index += 1) {
    offsets.push(offsets[index - 1]! + distanceBetween(points[index - 1]!, points[index]!))
  }
  return offsets
}

/** The sample at least `cells` of arc away in one direction, or -1 when the curve ends first. */
function reach(offsets: readonly number[], index: number, cells: number): number {
  const step = cells < 0 ? -1 : 1
  for (let walk = index + step; walk >= 0 && walk < offsets.length; walk += step) {
    if (Math.abs(offsets[walk]! - offsets[index]!) >= Math.abs(cells)) return walk
  }
  return -1
}

function distanceToPolyline(
  point: ContourCoordinate,
  polyline: readonly ContourCoordinate[],
): number {
  let nearest = Number.POSITIVE_INFINITY
  for (let index = 0; index + 1 < polyline.length; index += 1) {
    const start = polyline[index]!
    const end = polyline[index + 1]!
    const dx = end.x - start.x
    const dy = end.y - start.y
    const lengthSquared = dx * dx + dy * dy
    const amount =
      lengthSquared === 0
        ? 0
        : Math.max(
            0,
            Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
          )
    nearest = Math.min(
      nearest,
      Math.hypot(point.x - (start.x + dx * amount), point.y - (start.y + dy * amount)),
    )
  }
  return nearest
}

function round(value: number): string {
  return Number(value.toFixed(3)).toString()
}

/** Read the arguments the script passes, draw the village, and report what it measured. */
export async function runContourDebugCli(
  arguments_: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const values = new Map<string, string>()
  for (const argument of arguments_) {
    const [name, value] = argument.replace(/^--/, '').split('=')
    if (name === undefined || value === undefined) {
      throw new Error('Usage: contour-debug --rows=PATH --out=PATH [--seed=N] [--window=x,y,span]')
    }
    values.set(name, value)
  }
  const rowsPath = required(values.get('rows'), 'rows')
  const outPath = required(values.get('out'), 'out')
  const seed = Number(values.get('seed') ?? 0)
  const southFirst = (await readFile(rowsPath, 'utf8')).trim().split(/\r?\n/)
  const scene = contourDebugScene(topFirstRows(southFirst))
  const height = scene.rows.length
  const width = scene.rows[0]?.length ?? 0
  const [windowX, windowY, windowSpan] = (values.get('window') ?? '').split(',').map(Number)
  const options: SvgOptions = {
    x: Number.isFinite(windowX) ? windowX! : 0,
    y: Number.isFinite(windowY) ? windowY! : 0,
    span: Number.isFinite(windowSpan) ? windowSpan! : Math.max(width, height),
    scale: Number(values.get('scale') ?? 0) || 0,
    seed,
  }
  const scale = options.scale > 0 ? options.scale : Math.max(8, Math.round(1400 / options.span))
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, contourSvg(scene, { ...options, scale }), 'utf8')
  for (const line of reportLines(scene.measurements, options)) console.log(line)
  console.log(`wrote ${outPath}`)
}

function required(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`contour-debug needs --${name}=PATH`)
  return value
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  await runContourDebugCli()
}

export const CONTOUR_DEBUG_ENTRY = fileURLToPath(import.meta.url)
