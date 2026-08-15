import { describe, expect, it } from 'vitest'
import { HEARTHSIDE_STYLE } from './presentation.js'
import {
  type ContourCoordinate,
  planTerrainContours,
  TERRAIN_EXTERIOR,
  type TerrainContourChain,
  type TerrainContourPlan,
  type TerrainContourSettings,
  terrainHash,
  terrainVariant,
} from './terrain-contours.js'
import type { TerrainCurveProfile } from './terrain-curves.js'

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

const landProfile: TerrainCurveProfile = {
  sampleSpacingCells: 0.25,
  smoothingPasses: 72,
  octaves: [
    { wavelengthCells: 8, amplitudeCells: 0.28 },
    { wavelengthCells: 3, amplitudeCells: 0.12 },
    { wavelengthCells: 1.2, amplitudeCells: 0.05 },
  ],
}

const waterProfile: TerrainCurveProfile = {
  sampleSpacingCells: 0.2,
  smoothingPasses: 160,
  octaves: [
    { wavelengthCells: 11, amplitudeCells: 0.34 },
    { wavelengthCells: 4, amplitudeCells: 0.14 },
    { wavelengthCells: 1.5, amplitudeCells: 0.06 },
  ],
}

const settings: TerrainContourSettings = {
  profiles: { land: landProfile, water: waterProfile },
  junctionTangentCells: 0.25,
  maxDeviationCells: 0.6,
  minimumCorridorCells: 0.7,
  saddleRadiusCells: 0.08,
}

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

function sampleOpenContourAtRawOffsets(
  chain: TerrainContourChain,
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

describe('continuous terrain contour planning', () => {
  it('backs a forced nonincident crossing toward the raw planar graph', () => {
    const rows = [
      'gwwgggwg',
      'ggwwggww',
      'wggwwggw',
      'ggwggwww',
      'gwwgwggg',
      'gggwgwgg',
      'gwgggwgw',
      'ggwgggwg',
    ]
    const overrides = {
      profiles: {
        land: { smoothingPasses: 30 },
        water: { smoothingPasses: 30 },
      },
    } as const
    const result = plan(rows, overrides)

    expect(result).toEqual(plan(rows, overrides))
    expect(
      result.chains.some((chain) =>
        chain.points.some(
          (point) => !point.locked && distanceToPolyline(point, chain.rawPoints) > 0.01,
        ),
      ),
    ).toBe(true)
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

  it('is canonical and keeps hashing stable for equal input', () => {
    const rows = ['ggwww', 'gffww', 'gfrww', 'ggggg']
    expect(plan(rows)).toEqual(plan(rows))
    expect(terrainHash('g', 4, 7)).toBe(terrainHash('g', 4, 7))
    expect(terrainVariant(4, 'g', 4, 7)).toBeLessThan(4)
  })

  it('resolves both AB/BA saddle orientations through one deterministic centered diamond', () => {
    for (const rows of [
      ['gw', 'wg'],
      ['wg', 'gw'],
    ]) {
      const result = plan(rows)
      const saddle = result.saddles[0]!
      expect(result.saddles).toHaveLength(1)
      expect(saddle.materials).toEqual(['ground', 'water'])
      expect(['ground', 'water']).toContain(saddle.winner)
      const portals = new Set(
        result.chains
          .flatMap((chain) => chain.rawPoints)
          .filter(
            (point) =>
              Math.abs(Math.abs(point.x - 1) + Math.abs(point.y - 1) - settings.saddleRadiusCells) <
              1e-9,
          )
          .map((point) => `${point.x}:${point.y}`),
      )
      expect(portals).toEqual(new Set(['1:0.92', '1.08:1', '1:1.08', '0.92:1']))
      const saddleSpans = result.chains
        .flatMap((chain) => chain.spans)
        .filter((span) => span.saddle)
      expect(saddleSpans).toHaveLength(2)
      expect(saddleSpans.every((span) => span.fixed)).toBe(true)
      expect(
        result.components.filter(
          (candidate) => candidate.material === saddle.winner && !candidate.exterior,
        ),
      ).toHaveLength(1)
      expect(
        result.components.filter(
          (candidate) => candidate.material !== saddle.winner && !candidate.exterior,
        ),
      ).toHaveLength(2)
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

  it('suppresses staircase cadence as smoothing passes increase', () => {
    const size = 16
    const rows = Array.from(
      { length: size },
      (_, row) => `${'w'.repeat(row + 1)}${'g'.repeat(size - row - 1)}`,
    )
    const stairIn = (result: TerrainContourPlan): TerrainContourChain =>
      result.chains.find(
        (chain) =>
          chain.materials.includes('ground') &&
          chain.materials.includes('water') &&
          chain.rawPoints.length > 6,
      )!
    const unsmoothed = stairIn(
      plan(rows, { profiles: { water: { smoothingPasses: 0, octaves: [] } } }),
    )
    const smoothed = stairIn(plan(rows, { profiles: { water: { octaves: [] } } }))
    const ordinaryVertices = unsmoothed.rawPoints.slice(1, -1)
    const emittedVertices = ordinaryVertices.filter((vertex) =>
      smoothed.points.some((point) => Math.hypot(point.x - vertex.x, point.y - vertex.y) < 1e-9),
    )
    const unsmoothedSamples = sampleOpenContourAtRawOffsets(unsmoothed, 0.5)
    const smoothedSamples = sampleOpenContourAtRawOffsets(smoothed, 0.5)

    expect(emittedVertices.length).toBeLessThan(ordinaryVertices.length / 2)
    expect(contourCadence(smoothedSamples)).toBeLessThan(contourCadence(unsmoothedSamples))
    expect(contourCurvature(smoothedSamples)).toBeLessThan(contourCurvature(unsmoothedSamples))
  })

  it('builds direct holes while keeping a nested island as a separate component', () => {
    const result = plan(['ggggg', 'gwwwg', 'gwgwg', 'gwwwg', 'ggggg'])
    const outerGround = result.components.find(
      (candidate) => candidate.material === 'ground' && candidate.cellCount === 16,
    )!
    const water = component(result, 'water', 8)
    const island = component(result, 'ground', 1)
    expect(outerGround.holeRingIds).toHaveLength(1)
    expect(water.holeRingIds).toHaveLength(1)
    expect(island.holeRingIds).toHaveLength(0)
    expect([outerGround.nestingDepth, water.nestingDepth, island.nestingDepth]).toEqual([0, 1, 2])
    expect(water.parentComponentId).toBe(outerGround.id)
    expect(island.parentComponentId).toBe(water.id)
  })

  it('keeps curves in their tube and one-cell corridors wider than 0.70 cell', () => {
    const result = plan(['wwwww', 'ggggg', 'wwwww'])
    for (const chain of result.chains) {
      expect(
        Math.max(...chain.points.map((point) => distanceToPolyline(point, chain.rawPoints))),
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
    expect(HEARTHSIDE_STYLE.terrain.seams.waterHatch.bridgeTaperCells).toBe(0.35)
  })

  it('widens bridge shoreline taper reach from the configured cell distance', () => {
    const rows = ['ggggggg', 'gwwbwwg', 'ggggggg']
    const defaultShore = plan(rows).chains.find((chain) => chain.shorelineSpans.length > 0)!
    const widerShore = planTerrainContours(rows, names, settings, 0.5).chains.find(
      (chain) => chain.id === defaultShore.id,
    )!
    const partialCount = (points: readonly { shorelineFactor: number }[]): number =>
      points.filter((point) => point.shorelineFactor > 0 && point.shorelineFactor < 1).length

    expect(partialCount(widerShore.points)).toBeGreaterThan(partialCount(defaultShore.points))
  })

  it('keeps every turning-corridor segment inside its source tube', () => {
    const result = plan(['wwwww', 'wgggw', 'wwwgw', 'wwwww'], {
      profiles: { water: { octaves: [] } },
    })
    for (const chain of result.chains) {
      const points = chain.closed ? [...chain.points, chain.points[0]!] : chain.points
      for (let index = 0; index < points.length - 1; index += 1) {
        const start = points[index]!
        const end = points[index + 1]!
        const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
        expect(distanceToPolyline(midpoint, chain.rawPoints)).toBeLessThanOrEqual(
          settings.maxDeviationCells + 0.02 + 1e-8,
        )
      }
    }
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
