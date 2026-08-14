import { describe, expect, it } from 'vitest'

import {
  BRIDGE_SHORELINE_TAPER_CELLS,
  type ContourCoordinate,
  planTerrainContours,
  TERRAIN_EXTERIOR,
  type TerrainContourPlan,
  type TerrainContourSettings,
  terrainHash,
  terrainVariant,
} from './terrain-contours.js'

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

const settings: TerrainContourSettings = {
  smoothingPasses: 2,
  cornerWeight: 0.25,
  sampleSpacingCells: 0.25,
  junctionTangentCells: 0.25,
  noiseAmplitudeCells: 0.06,
  noiseWavelengthCells: [1.5, 3],
  maxDeviationCells: 0.15,
  saddleRadiusCells: 0.08,
}

function plan(
  rows: readonly string[],
  overrides: Partial<TerrainContourSettings> = {},
): TerrainContourPlan {
  return planTerrainContours(rows, names, { ...settings, ...overrides })
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

describe('continuous terrain contour planning', () => {
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
    }
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

  it('keeps curves in their tube, cell centers clear, and one-cell corridors wider than 0.70 cell', () => {
    const result = plan(['wwwww', 'ggggg', 'wwwww'])
    for (const chain of result.chains) {
      expect(
        Math.max(...chain.points.map((point) => distanceToPolyline(point, chain.rawPoints))),
      ).toBeLessThanOrEqual(settings.maxDeviationCells + 1e-8)
    }
    for (let column = 0; column < 5; column += 1) {
      const center = { x: column + 0.5, y: 1.5 }
      expect(
        Math.min(...result.chains.map((chain) => distanceToPolyline(center, chain.points))),
      ).toBeGreaterThanOrEqual(0.35)
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
    expect(minimumWidth).toBeGreaterThanOrEqual(0.7)
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
    expect(BRIDGE_SHORELINE_TAPER_CELLS).toBe(0.25)
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
    const result = plan(['wwwww', 'wgggw', 'wwwgw', 'wwwww'], { noiseAmplitudeCells: 0 })
    for (const chain of result.chains) {
      const points = chain.closed ? [...chain.points, chain.points[0]!] : chain.points
      for (let index = 0; index < points.length - 1; index += 1) {
        const start = points[index]!
        const end = points[index + 1]!
        const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
        expect(distanceToPolyline(midpoint, chain.rawPoints)).toBeLessThanOrEqual(
          settings.maxDeviationCells + 1e-8,
        )
      }
    }
  })

  it('plans a fragmented 120-cell map within a bounded startup budget', () => {
    const rows = Array.from({ length: 120 }, (_, row) =>
      Array.from({ length: 120 }, (_, column) => ((row + column) % 2 === 0 ? 'g' : 'w')).join(''),
    )
    const startedAt = performance.now()
    const result = plan(rows, { sampleSpacingCells: 0.5 })

    expect(result.components.length).toBeGreaterThan(100)
    expect(performance.now() - startedAt).toBeLessThan(20_000)
  }, 30_000)

  it('keeps a compact fragmented-plan signature deterministic', () => {
    const rows = Array.from({ length: 20 }, (_, row) =>
      Array.from({ length: 20 }, (_, column) => ((row + column) % 2 === 0 ? 'g' : 'w')).join(''),
    )
    const signature = (result: TerrainContourPlan): readonly unknown[] => [
      result.components.map((component) => [component.id, component.material, component.cellCount]),
      result.chains.map((chain) => [chain.id, chain.points.length, chain.rawLength]),
      result.saddles.map((saddle) => [saddle.x, saddle.y, saddle.winner]),
    ]

    expect(signature(plan(rows, { sampleSpacingCells: 0.5 }))).toEqual(
      signature(plan(rows, { sampleSpacingCells: 0.5 })),
    )
  })

  it('rejects grids or settings that cannot preserve the topology bounds', () => {
    expect(() => planTerrainContours([], names, settings)).toThrow(/non-empty rectangular grid/)
    expect(() => plan(['gg'], { sampleSpacingCells: 0.51 })).toThrow(/at most 0.5 cell/)
    expect(() => plan(['gg'], { noiseAmplitudeCells: 0.061 })).toThrow(/0.06 cell/)
    expect(() => plan(['gg'], { maxDeviationCells: 0.151 })).toThrow(/at most 0.15 cell/)
    expect(() => planTerrainContours(['gg'], names, settings, -0.01)).toThrow(
      /Bridge shoreline taper/,
    )
    expect(() => planTerrainContours(['gg'], names, settings, 1.01)).toThrow(
      /Bridge shoreline taper/,
    )
  })
})
