import { hashUnit, stableHashParts } from '@renderers/base/math.js'
import { describe, expect, it } from 'vitest'
import { readStatic } from './overlay.js'
import { HEARTHSIDE_STYLE } from './presentation.js'
import { buildStaticScene } from './scene.js'
import { MAX_REFERENCE_DRIFT_CELLS } from './terrain-contour-reference.js'
import { findCurveCrossings, maxCurveTubeDeviation } from './terrain-contour-validation.js'
import { planTerrainContours, TERRAIN_EXTERIOR } from './terrain-contours.js'
import { DEFAULT_TERRAIN_ROUTE_SETTINGS, planTerrainRoutes } from './terrain-routes.js'
import { fixtureRecording } from './test-helpers.js'
import type {
  ContourCoordinate,
  TerrainContourChain,
  TerrainContourPlan,
  TerrainContourSettings,
  TerrainCurveProfile,
} from './types.js'

const names: Readonly<Record<string, string>> = {
  g: 'ground',
  f: 'field',
  e: 'reeds',
  w: 'water',
  r: 'road',
  p: 'path',
  b: 'bridge',
  i: 'interior',
  d: 'doorway',
  x: 'wall',
}

// The sweeps run the shipping configuration. A second copy of the profiles here would drift from
// the one the game draws with, and the properties below are exactly the ones worth holding on it.
const settings: TerrainContourSettings = HEARTHSIDE_STYLE.terrain.contours

interface ContourTestOverrides extends Omit<Partial<TerrainContourSettings>, 'profiles'> {
  readonly profiles?: {
    readonly land?: Partial<TerrainCurveProfile>
    readonly water?: Partial<TerrainCurveProfile>
  }
}

function plan(rows: readonly string[], overrides: ContourTestOverrides = {}): TerrainContourPlan {
  const { profiles, ...contourOverrides } = overrides
  return planTerrainContours(
    rows,
    names,
    {
      ...settings,
      ...contourOverrides,
      profiles: {
        land: { ...settings.profiles.land, ...profiles?.land },
        water: { ...settings.profiles.water, ...profiles?.water },
      },
    },
    HEARTHSIDE_STYLE.terrain.seams.waterHatch.bridgeTaperCells,
  )
}

function component(planResult: TerrainContourPlan, material: string, cellCount?: number) {
  const found = planResult.components.find(
    (candidate) =>
      candidate.material === material &&
      (cellCount === undefined || candidate.cellCount === cellCount),
  )
  if (found === undefined) throw new Error(`Missing ${material} component.`)
  return found
}

function pointToSegment(
  point: ContourCoordinate,
  start: ContourCoordinate,
  end: ContourCoordinate,
): number {
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
  return Math.hypot(point.x - (start.x + dx * amount), point.y - (start.y + dy * amount))
}

function distanceToPolyline(
  point: ContourCoordinate,
  polyline: readonly ContourCoordinate[],
): number {
  return Math.min(
    ...polyline
      .slice(0, -1)
      .map((start, index) => pointToSegment(point, start, polyline[index + 1]!)),
  )
}

function contourCadence(points: readonly ContourCoordinate[]): number {
  let count = 0
  for (let index = 1; index < points.length - 1; index += 1) {
    const before = points[index - 1]!
    const point = points[index]!
    const after = points[index + 1]!
    const firstAngle = Math.atan2(point.y - before.y, point.x - before.x)
    const secondAngle = Math.atan2(after.y - point.y, after.x - point.x)
    if (Math.abs(normalizedAngle(secondAngle - firstAngle)) > 0.04) count += 1
  }
  return count
}

function normalizedAngle(angle: number): number {
  const turn = (angle + Math.PI) % (Math.PI * 2)
  return (turn < 0 ? turn + Math.PI * 2 : turn) - Math.PI
}

function contourCurvature(points: readonly ContourCoordinate[]): number {
  let total = 0
  for (let index = 1; index < points.length - 1; index += 1) {
    const before = points[index - 1]!
    const point = points[index]!
    const after = points[index + 1]!
    total += Math.hypot(after.x - 2 * point.x + before.x, after.y - 2 * point.y + before.y)
  }
  return total
}

/** The chain's own raw polyline in the shape the raw-offset sampler expects. */
function rawPointsWithOffsets(
  chain: TerrainContourChain,
): (ContourCoordinate & { readonly rawOffset: number })[] {
  let offset = 0
  return chain.rawPoints.map((point, index) => {
    if (index > 0) {
      const previous = chain.rawPoints[index - 1]!
      offset += Math.hypot(point.x - previous.x, point.y - previous.y)
    }
    return { x: point.x, y: point.y, rawOffset: offset }
  })
}

/**
 * Spread of each polyline around its own best-fit line. A staircase oscillates one step around
 * any line, so its spread is about a cell; the line it quantizes has none, so the spread is what
 * is left of the stair rhythm. Each polyline is measured against its own fit because the
 * reference may legitimately sit tilted within tolerance of the raw fit, hinged on its locked
 * junction ends, and a tilted straight line carries no rhythm.
 */
function stairResidual(chain: TerrainContourChain): {
  readonly raw: number
  readonly reference: number
  readonly emitted: number
} {
  const spread = (points: readonly ContourCoordinate[]): number => {
    // Trim the locked ends, which are pinned onto the raw staircase by design.
    const middle = points.slice(Math.ceil(points.length * 0.15), Math.floor(points.length * 0.85))
    const meanX = middle.reduce((sum, point) => sum + point.x, 0) / middle.length
    const meanY = middle.reduce((sum, point) => sum + point.y, 0) / middle.length
    let sxx = 0
    let sxy = 0
    let syy = 0
    for (const point of middle) {
      sxx += (point.x - meanX) ** 2
      sxy += (point.x - meanX) * (point.y - meanY)
      syy += (point.y - meanY) ** 2
    }
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy)
    const offsets = middle.map(
      (point) => (point.x - meanX) * -Math.sin(angle) + (point.y - meanY) * Math.cos(angle),
    )
    return Math.max(...offsets) - Math.min(...offsets)
  }
  return {
    raw: spread(chain.rawPoints),
    reference: spread(chain.referencePoints),
    emitted: spread(chain.points),
  }
}

function sampleOpenContourAtRawOffsets(
  chain: Pick<TerrainContourChain, 'rawLength'> & {
    readonly points: readonly (ContourCoordinate & { readonly rawOffset: number })[]
  },
  spacing: number,
): readonly (ContourCoordinate & { readonly rawOffset: number })[] {
  const offsets = Array.from({ length: Math.floor(chain.rawLength / spacing) + 1 }, (_, index) =>
    Math.min(chain.rawLength, index * spacing),
  )
  if (offsets.at(-1) !== chain.rawLength) offsets.push(chain.rawLength)

  let upperIndex = 1
  return offsets.map((offset) => {
    while (upperIndex < chain.points.length - 1 && chain.points[upperIndex]!.rawOffset < offset) {
      upperIndex += 1
    }
    const lower = chain.points[upperIndex - 1]!
    const upper = chain.points[upperIndex]!
    const span = upper.rawOffset - lower.rawOffset
    const amount = span <= 1e-9 ? 0 : (offset - lower.rawOffset) / span
    return {
      x: lower.x + (upper.x - lower.x) * amount,
      y: lower.y + (upper.y - lower.y) * amount,
      rawOffset: offset,
    }
  })
}

/** One smooth deterministic field, the shape a generated village elevation has. */
function smoothField(seed: number, x: number, y: number, wavelength: number): number {
  const column = Math.floor(x / wavelength)
  const row = Math.floor(y / wavelength)
  const fade = (value: number): number => value * value * (3 - 2 * value)
  const blendX = fade(x / wavelength - column)
  const blendY = fade(y / wavelength - row)
  const at = (offsetX: number, offsetY: number): number =>
    hashUnit(stableHashParts('layout-field', seed, column + offsetX, row + offsetY))
  const top = at(0, 0) + (at(1, 0) - at(0, 0)) * blendX
  const bottom = at(0, 1) + (at(1, 1) - at(0, 1)) * blendX
  return top + (bottom - top) * blendY
}

/**
 * A generated layout of water, reeds, fields, and ground. Quantizing a smooth field is what the
 * village generator does, so these carry the shapes that matter here: banks at every angle, thin
 * bands, single-cell islands, and material junctions.
 */
function generatedRows(seed: number, size: number): string[] {
  return Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => {
      const value = smoothField(seed, x, y, 6) * 0.7 + smoothField(seed + 100, x, y, 2.5) * 0.3
      if (value < 0.34) return 'w'
      if (value < 0.42) return 'e'
      return value > 0.66 ? 'f' : 'g'
    }).join(''),
  )
}

/**
 * The recorded 120 by 120 village the game actually draws. Planning validates every code against
 * the table above, so this fails loudly rather than quietly if the two ever diverge.
 */
function shippingRows(): readonly string[] {
  return buildStaticScene(readStatic(fixtureRecording().header)).topFirstRows
}

/**
 * The layouts the property sweeps run over. Generated seeds vary the layout rather than the noise
 * key, since the contour pass derives its noise from the layout itself. The recorded village goes
 * in as well: a property that holds on every synthetic grid and fails on the shipping map has not
 * been tested at all.
 */
const layoutSuite: readonly (readonly string[])[] = [
  ['ggww', 'ggww'],
  ['ggg', 'gww', 'ggw'],
  ['gwgwg'],
  ['ggggg', 'gwwwg', 'gwgwg', 'gwwwg', 'ggggg'],
  ['gggggg', 'gfffgg', 'gffegg', 'ggeewg', 'gggwwg', 'gggggg'],
  ['ggggggg', 'geggggg', 'ggeggeg', 'gggeegg', 'ggggegg', 'ggggggg'],
  ...[0, 1, 2, 3, 4, 5].map((seed) => generatedRows(seed, 32)),
  shippingRows(),
]

/**
 * Shaping bounds sample points, so the chords between them may sag a little further, most where
 * tangential slide stretches the spacing. The sweep allows that sag: it is a tripwire for
 * construction failures, which overshoot by half a cell or more, not a second calibration bound.
 */
const TUBE_SAG_CELLS = 0.08

describe('continuous terrain contour planning', () => {
  it('draws a planar curve graph inside its reference tube across the layout suite', () => {
    const failures: string[] = []
    for (const [index, rows] of layoutSuite.entries()) {
      const result = plan(rows)
      for (const [first, second] of findCurveCrossings(result.chains)) {
        failures.push(
          `layout ${index}: chain ${first.chain.id} crosses ${second.chain.id} near ` +
            `(${first.start.x.toFixed(2)}, ${first.start.y.toFixed(2)})`,
        )
      }
      const tube = maxCurveTubeDeviation(result.chains)
      if (tube.cells > settings.maxDeviationCells + TUBE_SAG_CELLS) {
        failures.push(
          `layout ${index}: chain ${tube.chainId} left its tube by ${tube.cells.toFixed(3)} cells ` +
            `at (${tube.at.x.toFixed(2)}, ${tube.at.y.toFixed(2)})`,
        )
      }
    }
    expect(failures).toEqual([])
  })

  it('leaves its junction approaches free to curve across the layout suite', () => {
    // Chains meeting at a junction continue each other's boundary rather than facing it across a
    // corridor. Counting them as competitors drives the clearance to nothing and pins both
    // approaches back onto the raw cell staircase, which is what makes a map look angular at every
    // material meeting.
    let near = 0
    let moved = 0
    let drift = 0
    for (const rows of layoutSuite) {
      for (const chain of plan(rows).chains) {
        if (chain.closed) continue
        const ends = [chain.rawPoints[0]!, chain.rawPoints.at(-1)!]
        for (const point of chain.points) {
          if (point.locked) continue
          const toJunction = Math.min(
            ...ends.map((end) => Math.hypot(point.x - end.x, point.y - end.y)),
          )
          if (toJunction > 1.2) continue
          const fromRaw = distanceToPolyline(point, chain.rawPoints)
          near += 1
          drift += fromRaw
          if (fromRaw > 0.05) moved += 1
        }
      }
    }
    expect(near).toBeGreaterThan(500)
    expect(moved / near).toBeGreaterThan(0.4)
    expect(drift / near).toBeGreaterThan(0.08)
  })

  it('closes straight, concave, diagonal, and disconnected regions against the exterior', () => {
    for (const rows of [['ggww', 'ggww'], ['ggg', 'gww', 'ggw'], ['gw', 'wg'], ['gwgwg']]) {
      const result = plan(rows)
      expect(
        result.rings.every(
          (ring) =>
            ring.points[0]?.x === ring.points.at(-1)?.x &&
            ring.points[0]?.y === ring.points.at(-1)?.y,
        ),
      ).toBe(true)
      expect(result.components.some((candidate) => candidate.material === TERRAIN_EXTERIOR)).toBe(
        true,
      )
      expect(result.components.every((candidate) => candidate.outerRingId !== '')).toBe(true)
    }
    expect(
      plan(['gwgwg']).components.filter((candidate) => candidate.material === 'water'),
    ).toHaveLength(2)
  })

  it('owns every shared chain exactly once in each direction', () => {
    const result = plan(['gfw', 'erp', 'rpg'])
    for (const chain of result.chains) {
      const uses = result.rings
        .flatMap((ring) => ring.uses)
        .filter((use) => use.chainId === chain.id)
      expect(uses).toHaveLength(2)
      expect(new Set(uses.map((use) => use.reversed))).toEqual(new Set([false, true]))
    }
  })

  it('is canonical for equal input', () => {
    const rows = ['ggwww', 'gffww', 'gfrww', 'ggggg']
    expect(plan(rows)).toEqual(plan(rows))
  })

  it('plans a corner-touching grid as separate components without special routing', () => {
    // The visual grid is normalized upstream, so a corner touch only reaches contour planning
    // through a direct call. It stays four cardinal components and still closes cleanly.
    for (const rows of [
      ['gw', 'wg'],
      ['wg', 'gw'],
    ]) {
      const result = plan(rows)
      expect(result.components.filter((candidate) => !candidate.exterior)).toHaveLength(4)
      expect(result.chains.every((chain) => chain.rawPoints.length > 1)).toBe(true)
      expect(
        result.rings.every(
          (ring) =>
            ring.points[0]?.x === ring.points.at(-1)?.x &&
            ring.points[0]?.y === ring.points.at(-1)?.y,
        ),
      ).toBe(true)
    }
  })

  it('preserves cyclic order at three- and four-material junctions', () => {
    for (const rows of [
      ['gf', 'gw'],
      ['gf', 'wr'],
    ]) {
      const result = plan(rows)
      const incident = result.chains.filter((chain) =>
        chain.rawPoints.some((point) => point.x === 1 && point.y === 1),
      )
      expect(incident.length).toBe(rows[1] === 'gw' ? 3 : 4)
      expect(
        incident.every((chain) =>
          chain.points.some((point) => point.x === 1 && point.y === 1 && point.locked),
        ),
      ).toBe(true)
      expect(
        incident.every(
          (chain) =>
            chain.rawLength <= settings.junctionTangentCells ||
            chain.points.some(
              (point) =>
                (Math.abs(point.rawOffset - settings.junctionTangentCells) < 1e-9 ||
                  Math.abs(chain.rawLength - point.rawOffset - settings.junctionTangentCells) <
                    1e-9) &&
                point.locked &&
                distanceToPolyline(point, chain.rawPoints) < 1e-9,
            ),
        ),
      ).toBe(true)
    }
  })

  it('suppresses the staircase cadence carried by the raw boundary', () => {
    const size = 16
    const rows = Array.from(
      { length: size },
      (_, row) => `${'w'.repeat(row + 1)}${'g'.repeat(size - row - 1)}`,
    )
    const shaped = plan(rows, { profiles: { water: { octaves: [] } } }).chains.find(
      (chain) =>
        chain.materials.includes('ground') &&
        chain.materials.includes('water') &&
        chain.rawPoints.length > 6,
    )!
    const ordinaryVertices = shaped.rawPoints.slice(1, -1)
    const emittedVertices = ordinaryVertices.filter((vertex) =>
      shaped.points.some((point) => Math.hypot(point.x - vertex.x, point.y - vertex.y) < 1e-9),
    )
    const rawSamples = sampleOpenContourAtRawOffsets(
      { ...shaped, points: rawPointsWithOffsets(shaped) },
      0.5,
    )
    const shapedSamples = sampleOpenContourAtRawOffsets(shaped, 0.5)

    expect(emittedVertices.length).toBeLessThan(ordinaryVertices.length / 2)
    expect(contourCadence(shapedSamples)).toBeLessThan(contourCadence(rawSamples) / 2)
    expect(contourCurvature(shapedSamples)).toBeLessThan(contourCurvature(rawSamples) / 2)
  })

  it('draws a diagonally stepping reed band as one unbroken ribbon', () => {
    // A one-wide band that steps diagonally used to touch itself only at cell corners: cardinal
    // connectivity split it into beads, and every touch corner became a pinned junction. The
    // normalized visual grid joins it edge to edge, in both diagonal orientations.
    for (const descending of [true, false]) {
      const height = 18
      const width = 26
      const rows = Array.from({ length: height }, (_, row) => {
        const step = descending ? row : height - 1 - row
        return Array.from({ length: width }, (_, column) =>
          column === 3 + step ? 'e' : column > 3 + step ? 'w' : 'g',
        ).join('')
      })
      const routes = planTerrainRoutes(rows, names, DEFAULT_TERRAIN_ROUTE_SETTINGS)
      const result = planTerrainContours(
        routes.visualRows,
        names,
        settings,
        HEARTHSIDE_STYLE.terrain.seams.waterHatch.bridgeTaperCells,
      )
      const reeds = result.components.filter((component) => component.material === 'reeds')

      expect(reeds).toHaveLength(1)
      expect(reeds[0]!.cellCount).toBeGreaterThan(height - 2)
      for (const chain of result.chains) {
        if (!chain.materials.includes('reeds')) continue
        for (let index = 1; index < chain.points.length - 1; index += 1) {
          const before = chain.points[index - 1]!
          const point = chain.points[index]!
          const after = chain.points[index + 1]!
          if (before.locked || point.locked || after.locked) continue
          if (
            Math.hypot(point.x - before.x, point.y - before.y) < 0.02 ||
            Math.hypot(after.x - point.x, after.y - point.y) < 0.02
          ) {
            continue
          }
          const firstAngle = Math.atan2(point.y - before.y, point.x - before.x)
          const secondAngle = Math.atan2(after.y - point.y, after.x - point.x)
          expect(Math.abs(normalizedAngle(secondAngle - firstAngle))).toBeLessThan(Math.PI / 3)
        }
      }
    }
  })

  it('flattens multi-cell stair runs onto the line they quantize', () => {
    for (const run of [2, 3, 6]) {
      const height = 12
      const width = run * height + 4
      const rows = Array.from({ length: height }, (_, row) => {
        const water = Math.min(width, run * (row + 1))
        return `${'w'.repeat(water)}${'g'.repeat(width - water)}`
      })
      const chain = plan(rows, { profiles: { water: { octaves: [] } } }).chains.find(
        (candidate) =>
          candidate.materials.includes('ground') &&
          candidate.materials.includes('water') &&
          candidate.rawPoints.length > 6,
      )!
      const residual = stairResidual(chain)

      expect(residual.raw).toBeGreaterThan(0.7)
      expect(residual.reference).toBeLessThan(0.1)
      expect(residual.emitted).toBeLessThan(0.25)
    }
  })

  it('flattens stair runs on both banks of a two-cell corridor', () => {
    const run = 3
    const height = 24
    const width = Math.ceil(height / run) + 6
    const rows = Array.from({ length: height }, (_, row) => {
      const start = 2 + Math.floor(row / run)
      return `${'g'.repeat(start)}ww${'g'.repeat(width - start - 2)}`
    })
    const banks = plan(rows, { profiles: { water: { octaves: [] } } }).chains.filter(
      (chain) =>
        chain.materials.includes('ground') &&
        chain.materials.includes('water') &&
        chain.rawPoints.length > 6,
    )
    expect(banks.length).toBeGreaterThan(0)
    for (const bank of banks) {
      // A corridor this narrow binds the drift ceiling, so its banks straighten part of the way
      // rather than all of it: the two boundaries may never spend more than half their slack.
      const residual = stairResidual(bank)
      expect(residual.raw).toBeGreaterThan(0.7)
      expect(residual.reference).toBeLessThan(residual.raw / 2)
    }
    const separation = Math.min(
      ...banks.flatMap((bank, index) =>
        banks
          .slice(index + 1)
          .flatMap((other) =>
            bank.points.map((point) =>
              Math.min(...other.points.map((far) => Math.hypot(point.x - far.x, point.y - far.y))),
            ),
          ),
      ),
    )
    if (Number.isFinite(separation)) {
      expect(separation).toBeGreaterThanOrEqual(settings.minimumCorridorCells - 1e-6)
    }
  })

  it('builds direct holes while keeping an island as a separate component', () => {
    const result = plan(['ggggg', 'gwwwg', 'gwgwg', 'gwwwg', 'ggggg'])
    const outerGround = result.components.find(
      (candidate) => candidate.material === 'ground' && candidate.cellCount === 16,
    )!
    const water = component(result, 'water', 8)
    const island = component(result, 'ground', 1)
    expect(outerGround.holeRingIds).toHaveLength(1)
    expect(water.holeRingIds).toHaveLength(1)
    expect(island.holeRingIds).toHaveLength(0)
  })

  it('keeps curves in their tube and one-cell corridors wider than 0.70 cell', () => {
    const result = plan(['wwwww', 'ggggg', 'wwwww'])
    for (const chain of result.chains) {
      expect(
        Math.max(...chain.points.map((point) => distanceToPolyline(point, chain.referencePoints))),
      ).toBeLessThanOrEqual(settings.maxDeviationCells + 0.02 + 1e-8)
    }
    const allPoints = result.chains.flatMap((chain) => chain.points)
    const upper = allPoints.filter((point) => point.y < 1.3 && point.x >= 0.25 && point.x <= 4.75)
    const lower = allPoints.filter((point) => point.y > 1.7 && point.x >= 0.25 && point.x <= 4.75)
    const minimumWidth = Math.min(
      ...upper.map((point) =>
        Math.min(...lower.map((other) => Math.hypot(point.x - other.x, point.y - other.y))),
      ),
      ...lower.map((point) =>
        Math.min(...upper.map((other) => Math.hypot(point.x - other.x, point.y - other.y))),
      ),
    )
    expect(minimumWidth).toBeGreaterThanOrEqual(settings.minimumCorridorCells)
  })

  it('locks structures, map borders, junction tangents, and bridge portals', () => {
    const result = plan(['gggggg', 'gidxbg', 'grwwpg', 'gggggg'])
    const borderChains = result.chains.filter((chain) => chain.materials.includes(TERRAIN_EXTERIOR))
    expect(borderChains.length).toBeGreaterThan(0)
    expect(borderChains.every((chain) => chain.points.every((point) => point.locked))).toBe(true)
    const structureChains = result.chains.filter((chain) =>
      chain.materials.some((material) => ['interior', 'doorway', 'wall'].includes(material)),
    )
    expect(structureChains.some((chain) => chain.materials.includes('doorway'))).toBe(true)
    expect(structureChains.every((chain) => chain.points.every((point) => point.locked))).toBe(true)
    expect(
      structureChains.every((chain) =>
        chain.points.every((point) => distanceToPolyline(point, chain.rawPoints) < 1e-9),
      ),
    ).toBe(true)
    const bridgePortal = result.chains.find((chain) =>
      chain.spans.some((span) => span.bridgeSuppressed),
    )!
    expect(bridgePortal.spans.some((span) => span.bridgeSuppressed && span.fixed)).toBe(true)
    expect(bridgePortal.points.some((point) => point.locked && point.shorelineFactor === 0)).toBe(
      true,
    )
  })

  it('unions bridge with water while retaining shoreline provenance, suppression, and taper', () => {
    const result = plan(['ggggg', 'gwbwg', 'ggggg'])
    expect(result.components.filter((candidate) => candidate.material === 'water')).toHaveLength(1)
    expect(component(result, 'water').cellCount).toBe(3)
    expect(result.chains.every((chain) => !chain.materials.includes('bridge'))).toBe(true)
    const shore = result.chains.find((chain) =>
      chain.shorelineSpans.some((span) => span.waterSemantics.includes('bridge')),
    )!
    expect(shore.shorelineSpans.some((span) => span.suppressed)).toBe(true)
    expect(
      shore.shorelineSpans.some(
        (span) => !span.suppressed && span.waterSemantics.includes('water'),
      ),
    ).toBe(true)
    expect(shore.points.some((point) => point.shorelineFactor === 0)).toBe(true)
    expect(shore.points.some((point) => point.shorelineFactor === 1)).toBe(true)
  })

  it('ramps bridge shoreline suppression more gently as the taper distance grows', () => {
    const rows = ['ggggggg', 'gwwbwwg', 'ggggggg']
    const defaultShore = plan(rows).chains.find((chain) => chain.shorelineSpans.length > 0)!
    const widerShore = planTerrainContours(rows, names, settings, 0.5).chains.find(
      (chain) => chain.id === defaultShore.id,
    )!
    // The taper sets suppression strength alone, so both plans emit the same points and every
    // point on the ramp is weaker under the wider one.
    expect(widerShore.points).toHaveLength(defaultShore.points.length)
    let ramped = 0
    for (const [index, point] of defaultShore.points.entries()) {
      const wider = widerShore.points[index]!
      expect(wider.rawOffset).toBeCloseTo(point.rawOffset, 9)
      if (point.shorelineFactor <= 0 || point.shorelineFactor >= 1) continue
      expect(wider.shorelineFactor).toBeLessThan(point.shorelineFactor)
      ramped += 1
    }
    expect(ramped).toBeGreaterThan(0)
    expect(widerShore.points.some((point) => point.shorelineFactor === 0)).toBe(true)
  })

  it('keeps every turning-corridor segment inside its reference tube', () => {
    const result = plan(['wwwww', 'wgggw', 'wwwgw', 'wwwww'], {
      profiles: { water: { octaves: [] } },
    })
    for (const chain of result.chains) {
      const points = chain.closed ? [...chain.points, chain.points[0]!] : chain.points
      const reference = chain.closed
        ? [...chain.referencePoints, chain.referencePoints[0]!]
        : chain.referencePoints
      for (let index = 0; index < points.length - 1; index += 1) {
        const start = points[index]!
        const end = points[index + 1]!
        const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
        expect(distanceToPolyline(midpoint, reference)).toBeLessThanOrEqual(
          settings.maxDeviationCells + 0.02 + 1e-8,
        )
      }
    }
  })

  it('renders a one-cell staircase band as diagonals instead of stairs', () => {
    const rows = ['ggggggg', 'ggggggg', 'eeeeggg', 'wwweeee', 'wwwwwww']
    const result = plan(rows)
    const bandChains = result.chains.filter(
      (chain) => chain.materials.includes('reeds') && !chain.materials.includes(TERRAIN_EXTERIOR),
    )
    expect(bandChains).toHaveLength(2)
    for (const chain of bandChains) {
      const free = chain.points.filter((point) => !point.locked)
      expect(
        Math.max(...free.map((point) => distanceToPolyline(point, chain.rawPoints))),
      ).toBeGreaterThan(0.2)
      for (let index = 1; index < chain.points.length - 1; index += 1) {
        const before = chain.points[index - 1]!
        const point = chain.points[index]!
        const after = chain.points[index + 1]!
        if (before.locked || point.locked || after.locked) continue
        if (
          Math.hypot(point.x - before.x, point.y - before.y) < 0.02 ||
          Math.hypot(after.x - point.x, after.y - point.y) < 0.02
        ) {
          continue
        }
        const firstAngle = Math.atan2(point.y - before.y, point.x - before.x)
        const secondAngle = Math.atan2(after.y - point.y, after.x - point.x)
        expect(Math.abs(normalizedAngle(secondAngle - firstAngle))).toBeLessThan(Math.PI / 3)
      }
    }
    const [first, second] = bandChains
    const separation = Math.min(
      ...first!.points.map((point) =>
        Math.min(
          ...second!.points.map((other) => Math.hypot(point.x - other.x, point.y - other.y)),
        ),
      ),
    )
    expect(separation).toBeGreaterThanOrEqual(settings.minimumCorridorCells - 1e-6)
  })

  it('exposes a reference near the raw boundary that keeps the closed seam contract', () => {
    const pond = plan(['gggg', 'gwwg', 'gwwg', 'gggg'])
    const shore = pond.chains.find((chain) => chain.closed && chain.materials.includes('water'))!
    const corners = [
      { x: 1, y: 1 },
      { x: 3, y: 1 },
      { x: 3, y: 3 },
      { x: 1, y: 3 },
    ]
    // A square pond's corners are genuine shape, so the reference may keep them exactly; the
    // emitted curve rounds them, so no drawn point sits on a corner itself.
    expect(
      shore.points.some((point) =>
        corners.some((corner) => Math.hypot(point.x - corner.x, point.y - corner.y) < 1e-9),
      ),
    ).toBe(false)
    const closedReference = [...shore.referencePoints, shore.referencePoints[0]!]
    for (const point of closedReference) {
      expect(distanceToPolyline(point, [...shore.rawPoints])).toBeLessThanOrEqual(
        MAX_REFERENCE_DRIFT_CELLS + 1e-9,
      )
    }
    expect(shore.points[0]!.rawOffset).toBe(0)
    for (let index = 1; index < shore.points.length; index += 1) {
      expect(shore.points[index]!.rawOffset).toBeGreaterThanOrEqual(
        shore.points[index - 1]!.rawOffset - 1e-9,
      )
    }
    expect(shore.points.at(-1)!.rawOffset).toBeLessThan(shore.rawLength + 1e-9)
  })

  it('caps free-point deviation to the local corridor, then lets it open up where terrain is wide', () => {
    const narrowLimit = (1 - settings.minimumCorridorCells) / 2
    const narrow = plan(['wwwww', 'ggggg', 'wwwww'])
    const narrowDeviations = narrow.chains.flatMap((chain) =>
      chain.points
        .filter((point) => !point.locked)
        .map((point) => distanceToPolyline(point, chain.rawPoints)),
    )
    expect(Math.max(...narrowDeviations)).toBeLessThanOrEqual(narrowLimit + 1e-8)

    const wideRows = [
      ...Array.from({ length: 3 }, () => 'w'.repeat(20)),
      ...Array.from({ length: 3 }, () => 'g'.repeat(20)),
    ]
    const wide = plan(wideRows)
    const wideDeviations = wide.chains.flatMap((chain) =>
      chain.points
        .filter((point) => !point.locked)
        .map((point) => distanceToPolyline(point, chain.rawPoints)),
    )
    expect(Math.max(...wideDeviations)).toBeGreaterThan(narrowLimit + 1e-8)
  })

  it('uses nonperiodic smooth noise along a long straight chain', () => {
    const width = 80
    const result = plan(['w'.repeat(width), 'g'.repeat(width)], {
      profiles: {
        water: { smoothingPasses: 0, sampleSpacingCells: 0.25 },
      },
    })
    const boundary = result.chains.find(
      (chain) => chain.materials.includes('ground') && chain.materials.includes('water'),
    )!
    const samples = boundary.points
      .filter((point) => !point.locked && point.rawOffset > 2 && point.rawOffset < width - 2)
      .sort((first, second) => first.rawOffset - second.rawOffset)
    const extrema: number[] = []
    for (let index = 1; index < samples.length - 1; index += 1) {
      const previous = samples[index - 1]!.y - 1
      const current = samples[index]!.y - 1
      const next = samples[index + 1]!.y - 1
      if ((current - previous) * (next - current) < 0) extrema.push(samples[index]!.rawOffset)
    }
    const gaps = extrema.slice(1).map((offset, index) => offset - extrema[index]!)

    expect(gaps.length).toBeGreaterThan(3)
    expect(new Set(gaps.map((gap) => gap.toFixed(2))).size).toBeGreaterThan(2)
  })

  it('keys world-space noise from the complete static layout', () => {
    const width = 40
    const baseRows = ['w'.repeat(width), 'g'.repeat(width), 'g'.repeat(width)]
    const changedRows = [...baseRows.slice(0, -1), `${'g'.repeat(width - 1)}f`]
    const boundary = (rows: readonly string[]) =>
      plan(rows).chains.find(
        (chain) =>
          chain.materials.includes('ground') &&
          chain.materials.includes('water') &&
          chain.rawLength === width,
      )!

    const coordinates = (rows: readonly string[]) =>
      boundary(rows).rawPoints.map(({ x, y }) => ({ x, y }))
    expect(coordinates(baseRows)).toEqual(coordinates(changedRows))
    expect(boundary(baseRows).points).not.toEqual(boundary(changedRows).points)
  })

  it('plans a long winding 120-cell chain within a bounded startup budget', () => {
    const cells = Array.from({ length: 120 }, () => Array.from({ length: 120 }, () => 'g'))
    const waterRows = Array.from({ length: 30 }, (_, index) => index * 4 + 1)
    for (let band = 0; band < waterRows.length; band += 1) {
      const row = waterRows[band]!
      for (let column = 1; column < 119; column += 1) cells[row]![column] = 'w'
      const nextRow = waterRows[band + 1]
      if (nextRow === undefined) continue
      const connectorColumn = band % 2 === 0 ? 118 : 1
      for (let connectorRow = row + 1; connectorRow < nextRow; connectorRow += 1) {
        cells[connectorRow]![connectorColumn] = 'w'
      }
    }
    const rows = cells.map((row) => row.join(''))
    const startedAt = performance.now()
    const result = plan(rows)
    const longChain = result.chains.find(
      (chain) => chain.materials.includes('ground') && chain.materials.includes('water'),
    )

    expect(longChain).toBeDefined()
    expect(longChain!.spans.length).toBeGreaterThan(6_000)
    expect(performance.now() - startedAt).toBeLessThan(20_000)
  }, 30_000)

  it('plans a fragmented 120-cell map within a bounded startup budget', () => {
    const rows = Array.from({ length: 120 }, (_, row) =>
      Array.from({ length: 120 }, (_, column) => ((row + column) % 2 === 0 ? 'g' : 'w')).join(''),
    )
    const startedAt = performance.now()
    const result = plan(rows)

    expect(result.components.length).toBeGreaterThan(100)
    expect(performance.now() - startedAt).toBeLessThan(20_000)
  }, 30_000)

  it('rejects grids or settings that cannot preserve the topology bounds', () => {
    expect(() =>
      planTerrainContours(
        [],
        names,
        settings,
        HEARTHSIDE_STYLE.terrain.seams.waterHatch.bridgeTaperCells,
      ),
    ).toThrow(/non-empty rectangular grid/)
    expect(() => plan(['gg'], { profiles: { land: { sampleSpacingCells: 4.01 } } })).toThrow(
      /land profile.*sample spacing/,
    )
    expect(() =>
      plan(['gg'], {
        profiles: { water: { octaves: [{ wavelengthCells: 5, amplitudeCells: 4.01 }] } },
      }),
    ).toThrow(/water profile.*octave amplitude/)
    expect(() => plan(['gg'], { maxDeviationCells: 0.76 })).toThrow(/at most 0.75 cell/)
    expect(() => planTerrainContours(['gg'], names, settings, -0.01)).toThrow(
      /Bridge shoreline taper/,
    )
    expect(() => planTerrainContours(['gg'], names, settings, 1.01)).toThrow(
      /Bridge shoreline taper/,
    )
  })
})
