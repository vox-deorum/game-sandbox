import { stableHashParts } from '@renderers/base/math.js'
import { writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { HEARTHSIDE_STYLE } from './presentation.js'
import { buildCells, buildComponents, findSaddles, validateInputs } from './terrain-contour-grid.js'
import { buildChains, buildGraph } from './terrain-contour-graph.js'
import { assignComponentAndRingIds, buildRings } from './terrain-contour-rings.js'
import { buildClearanceIndex, buildContourReferences, shapeChains } from './terrain-contour-shaping.js'
import { repairAndValidateCurveGraph } from './terrain-contour-validation.js'
import { planTerrainContours } from './terrain-contours.js'
import type { ContourCoordinate } from './types.js'

const names: Readonly<Record<string, string>> = { g: 'ground', e: 'reeds', w: 'water' }

function report(label: string, rows: readonly string[], run: number, chainId?: string): void {
  const result = planTerrainContours(
    rows,
    names,
    { ...HEARTHSIDE_STYLE.terrain.contours, profiles: HEARTHSIDE_STYLE.terrain.contours.profiles },
    HEARTHSIDE_STYLE.terrain.seams.waterHatch.bridgeTaperCells,
  )
  const chain =
    chainId === undefined
      ? result.chains.find(
          (candidate) =>
            candidate.materials.includes('ground') &&
            candidate.materials.includes('water') &&
            candidate.rawPoints.length > 6,
        )
      : result.chains.find((candidate) => candidate.id === chainId)
  if (chain === undefined) throw new Error(`no chain for ${label}`)
  // Best-fit line of the raw staircase, so the residual spread is the leftover stair amplitude
  // rather than an offset baked into the endpoint chord.
  const fit = chain.rawPoints
  const meanX = fit.reduce((sum, point) => sum + point.x, 0) / fit.length
  const meanY = fit.reduce((sum, point) => sum + point.y, 0) / fit.length
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (const point of fit) {
    sxx += (point.x - meanX) ** 2
    sxy += (point.x - meanX) * (point.y - meanY)
    syy += (point.y - meanY) ** 2
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  const normal = { x: -Math.sin(angle), y: Math.cos(angle) }
  const signedDistance = (point: ContourCoordinate): number =>
    (point.x - meanX) * normal.x + (point.y - meanY) * normal.y
  const spread = (points: readonly ContourCoordinate[]): number =>
    Math.max(...points.map(signedDistance)) - Math.min(...points.map(signedDistance))
  const lineDistance = (point: ContourCoordinate): number => Math.abs(signedDistance(point))
  const free = chain.points.filter((point) => !point.locked)
  const turns: number[] = []
  for (let index = 1; index < chain.points.length - 1; index += 1) {
    const before = chain.points[index - 1]!
    const point = chain.points[index]!
    const after = chain.points[index + 1]!
    if (
      Math.hypot(point.x - before.x, point.y - before.y) < 1e-6 ||
      Math.hypot(after.x - point.x, after.y - point.y) < 1e-6
    ) {
      continue
    }
    const firstAngle = Math.atan2(point.y - before.y, point.x - before.x)
    const secondAngle = Math.atan2(after.y - point.y, after.x - point.x)
    let turn = secondAngle - firstAngle
    while (turn > Math.PI) turn -= 2 * Math.PI
    while (turn < -Math.PI) turn += 2 * Math.PI
    turns.push(Math.abs(turn))
  }
  const interior = (points: readonly ContourCoordinate[]): ContourCoordinate[] =>
    points.slice(Math.ceil(points.length * 0.15), Math.floor(points.length * 0.85))
  console.log(
    `${label} run=${run} spreadRaw=${spread(interior(chain.rawPoints)).toFixed(3)} ` +
      `spreadRef=${spread(interior(chain.referencePoints)).toFixed(3)} ` +
      `spreadEmitted=${spread(interior(free)).toFixed(3)} ` +
      `maxEmittedDist=${Math.max(...interior(free).map(lineDistance)).toFixed(3)} ` +
      `maxTurnDeg=${((Math.max(...turns) * 180) / Math.PI).toFixed(1)}`,
  )
}

it('times the fragmented map by phase', () => {
  const rows = Array.from({ length: 120 }, (_, row) =>
    Array.from({ length: 120 }, (_, column) => ((row + column) % 2 === 0 ? 'g' : 'w')).join(''),
  )
  const settings = HEARTHSIDE_STYLE.terrain.contours
  const { width, height } = validateInputs(rows, names, settings, 0.35)
  const layoutHash = stableHashParts('terrain-layout', width, height, rows.join('\n'))
  const marks: string[] = []
  let last = performance.now()
  const mark = (label: string): void => {
    marks.push(`${label}=${(performance.now() - last).toFixed(0)}`)
    last = performance.now()
  }
  const cells = buildCells(rows, names, width, height)
  const saddles = findSaddles(cells, width, height, settings.saddleRadiusCells)
  const componentRecords = buildComponents(cells, saddles)
  const componentKeyForCell = new Map<number, string>()
  for (const component of componentRecords) {
    for (const cell of component.cells) componentKeyForCell.set(cell.index, component.key)
  }
  mark('grid')
  const graph = buildGraph(cells, width, height, saddles, componentKeyForCell)
  const chains = buildChains(graph.nodes, graph.segments)
  mark('graph')
  buildContourReferences(chains, settings, layoutHash)
  mark('reference')
  const clearanceIndex = buildClearanceIndex(chains)
  mark('index')
  shapeChains(chains, settings, 0.35, layoutHash, clearanceIndex)
  mark('shape')
  repairAndValidateCurveGraph(chains, settings.maxDeviationCells)
  mark('validate')
  const rings = buildRings(graph.nodes, graph.segments, chains)
  assignComponentAndRingIds(componentRecords, rings)
  mark('rings')
  console.log(
    `fragmented ${marks.join(' ')} chains=${chains.length} ` +
      `refPts=${chains.reduce((sum, chain) => sum + chain.reference!.points.length, 0)} ` +
      `emittedPts=${chains.reduce((sum, chain) => sum + chain.points.length, 0)}`,
  )
  expect(chains.length).toBeGreaterThan(0)
})

it('probes the two-cell corridor', () => {
  const run = 3
  const height = 24
  const width = Math.ceil(height / run) + 6
  const rows = Array.from({ length: height }, (_, row) => {
    const start = 2 + Math.floor(row / run)
    return `${'g'.repeat(start)}ww${'g'.repeat(width - start - 2)}`
  })
  const result = planTerrainContours(
    rows,
    names,
    {
      ...HEARTHSIDE_STYLE.terrain.contours,
      profiles: {
        land: HEARTHSIDE_STYLE.terrain.contours.profiles.land,
        water: { ...HEARTHSIDE_STYLE.terrain.contours.profiles.water, octaves: [] },
      },
    },
    HEARTHSIDE_STYLE.terrain.seams.waterHatch.bridgeTaperCells,
  )
  for (const chain of result.chains) {
    if (!chain.materials.includes('water') || chain.rawPoints.length <= 6) continue
    const locked = chain.points.filter((point) => point.locked).length
    console.log(
      `corridor chain=${chain.id} materials=${chain.materials.join('/')} closed=${chain.closed} ` +
        `rawLength=${chain.rawLength.toFixed(1)} refPts=${chain.referencePoints.length} ` +
        `lockedEmitted=${locked}/${chain.points.length}`,
    )
    report('corridorBank', rows, run, chain.id)
  }
  expect(result.chains.length).toBeGreaterThan(0)
})

it('probes the cadence scenario', () => {
  const size = 16
  const rows = Array.from(
    { length: size },
    (_, row) => `${'w'.repeat(row + 1)}${'g'.repeat(size - row - 1)}`,
  )
  for (const passes of [0, 24]) {
    const result = planTerrainContours(
      rows,
      names,
      {
        ...HEARTHSIDE_STYLE.terrain.contours,
        profiles: {
          land: HEARTHSIDE_STYLE.terrain.contours.profiles.land,
          water: {
            ...HEARTHSIDE_STYLE.terrain.contours.profiles.water,
            smoothingPasses: passes,
            octaves: [],
          },
        },
      },
      HEARTHSIDE_STYLE.terrain.seams.waterHatch.bridgeTaperCells,
    )
    const chain = result.chains.find(
      (candidate) =>
        candidate.materials.includes('ground') &&
        candidate.materials.includes('water') &&
        candidate.rawPoints.length > 6,
    )!
    const steps = chain.points
      .slice(1)
      .map((point, index) => Math.hypot(point.x - chain.points[index]!.x, point.y - chain.points[index]!.y))
    const rawGaps = chain.points
      .slice(1)
      .map((point, index) => point.rawOffset - chain.points[index]!.rawOffset)
    const samples = Array.from({ length: Math.floor(chain.rawLength / 0.5) + 1 }, (_, index) => {
      const offset = Math.min(chain.rawLength, index * 0.5)
      let upper = 1
      while (upper < chain.points.length - 1 && chain.points[upper]!.rawOffset < offset) upper += 1
      const low = chain.points[upper - 1]!
      const high = chain.points[upper]!
      const span = high.rawOffset - low.rawOffset
      const amount = span <= 1e-9 ? 0 : (offset - low.rawOffset) / span
      return { x: low.x + (high.x - low.x) * amount, y: low.y + (high.y - low.y) * amount }
    })
    let curvature = 0
    for (let index = 1; index < samples.length - 1; index += 1) {
      const before = samples[index - 1]!
      const point = samples[index]!
      const after = samples[index + 1]!
      curvature += Math.hypot(after.x - 2 * point.x + before.x, after.y - 2 * point.y + before.y)
    }
    const tiny = steps.filter((step) => step < 0.01).length
    console.log(
      `passes=${passes} emitted=${chain.points.length} curvature=${curvature.toFixed(3)} ` +
        `tinySteps=${tiny} minStep=${Math.min(...steps).toFixed(4)} ` +
        `minRawGap=${Math.min(...rawGaps).toFixed(4)} ` +
        `locked=${chain.points.filter((point) => point.locked).length}`,
    )
  }
  expect(true).toBe(true)
})

it('probes stair runs of several lengths', () => {
  for (const run of [1, 2, 3, 6]) {
    const height = 12
    const width = run * height + 4
    const rows = Array.from({ length: height }, (_, row) => {
      const water = Math.min(width, run * (row + 1))
      return `${'w'.repeat(water)}${'g'.repeat(width - water)}`
    })
    report('stair', rows, run)
  }
  expect(true).toBe(true)
})

it('dumps a slope-quantized bank for visual review', () => {
  // A shallow bank quantized into 4-cell runs, with a thin reed strip riding along it.
  const width = 56
  const height = 34
  const rows = Array.from({ length: height }, (_, row) => {
    let line = ''
    for (let column = 0; column < width; column += 1) {
      const bank = 6 + Math.floor(column / 4) + (column > 30 ? Math.floor((column - 30) / 3) : 0)
      if (row > bank + 1) line += 'w'
      else if (row > bank - 1) line += 'e'
      else line += 'g'
    }
    return line
  })
  const result = planTerrainContours(
    rows,
    names,
    HEARTHSIDE_STYLE.terrain.contours,
    HEARTHSIDE_STYLE.terrain.seams.waterHatch.bridgeTaperCells,
  )
  const directory =
    'C:/Users/JOHNCH~1/AppData/Local/Temp/claude/f--Minor-Solutions-game-sandbox/2337144c-dc98-4589-b8be-e6c4912b6d15/scratchpad'
  writeFileSync(
    `${directory}/contour-dump.json`,
    JSON.stringify({
      width: result.width,
      height: result.height,
      rows,
      components: result.components.map((component) => ({
        material: component.material,
        exterior: component.exterior,
        outerRingId: component.outerRingId,
        holeRingIds: component.holeRingIds,
      })),
      rings: result.rings.map((ring) => ({
        id: ring.id,
        material: ring.material,
        role: ring.role,
        points: ring.points,
      })),
    }),
  )
  expect(result.chains.length).toBeGreaterThan(0)
})
