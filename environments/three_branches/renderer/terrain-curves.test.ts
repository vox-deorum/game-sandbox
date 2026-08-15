import { describe, expect, it } from 'vitest'

import {
  shapeTerrainCurve,
  type TerrainCurvePoint,
  type TerrainCurveProfile,
  type TerrainCurveSourcePoint,
} from './terrain-curves.js'

const BASE_PROFILE: TerrainCurveProfile = {
  sampleSpacingCells: 0.25,
  macroWindowCells: 0,
  fairingIterations: 0,
  fairingRadiusCells: 1.5,
  fairingStrength: 0.4,
  noiseAmplitudeCells: 0,
  noiseWavelengthCells: [3, 7],
}

const WATER_PROFILE: TerrainCurveProfile = {
  sampleSpacingCells: 0.2,
  macroWindowCells: 4,
  fairingIterations: 6,
  fairingRadiusCells: 2.5,
  fairingStrength: 0.45,
  noiseAmplitudeCells: 0,
  noiseWavelengthCells: [7, 12],
}

describe('shared terrain curve shaping', () => {
  it('validates source geometry, seeds, and every profile range', () => {
    expect(() => shapeTerrainCurve([], false, BASE_PROFILE, 0)).toThrow('at least 2')
    expect(() =>
      shapeTerrainCurve([point(0, 0), point(1, 0), point(0, 0)], true, BASE_PROFILE, 0),
    ).toThrow('repeats its first point')
    expect(() => shapeTerrainCurve([point(0, 0), point(0, 0)], false, BASE_PROFILE, 0)).toThrow(
      'consecutive duplicate',
    )
    expect(() => shapeTerrainCurve([point(0, 0), point(1, 0)], false, BASE_PROFILE, 0.5)).toThrow(
      'finite integer',
    )

    const invalidProfiles: Array<[Partial<TerrainCurveProfile>, string]> = [
      [{ sampleSpacingCells: 0 }, 'sample spacing'],
      [{ macroWindowCells: -0.01 }, 'macro window'],
      [{ fairingIterations: 1.5 }, 'fairing iterations'],
      [{ fairingRadiusCells: 0 }, 'fairing radius'],
      [{ fairingStrength: 1.01 }, 'fairing strength'],
      [{ noiseAmplitudeCells: -0.01 }, 'noise amplitude'],
      [{ noiseWavelengthCells: [4, 3] }, 'must be ordered'],
    ]
    for (const [override, message] of invalidProfiles) {
      expect(() =>
        shapeTerrainCurve([point(0, 0), point(1, 0)], false, { ...BASE_PROFILE, ...override }, 0),
      ).toThrow(message)
    }
  })

  it('is deterministic for equal open and closed inputs', () => {
    const open = [point(0, 0), point(2, 0), point(2, 2), point(4, 2)]
    const closed = [point(0, 0), point(3, 0), point(3, 2), point(0, 2)]
    const profile = { ...WATER_PROFILE, noiseAmplitudeCells: 0.08 }

    expect(shapeTerrainCurve(open, false, profile, 42)).toEqual(
      shapeTerrainCurve(open, false, profile, 42),
    )
    expect(shapeTerrainCurve(closed, true, profile, 42)).toEqual(
      shapeTerrainCurve(closed, true, profile, 42),
    )
    expect(shapeTerrainCurve(open, false, profile, 42)).not.toEqual(
      shapeTerrainCurve(open, false, profile, 43),
    )
  })

  it('keeps locks exact and prevents either free interval from sampling across them', () => {
    const first = [point(-1, 1), point(0, 1), point(1, 1, true), point(2, 1), point(3, 1)]
    const changedLeft = [point(1, -1), point(1, 0), point(1, 1, true), point(2, 1), point(3, 1)]
    const profile = { ...WATER_PROFILE, noiseAmplitudeCells: 0.05 }
    const shaped = shapeTerrainCurve(first, false, profile, 19)
    const changed = shapeTerrainCurve(changedLeft, false, profile, 19)
    const lock = shaped.find((sample) => sample.locked && sample.sourceOffset === 2)

    expect(lock).toEqual({ x: 1, y: 1, sourceOffset: 2, locked: true })
    expect(shaped.filter((sample) => sample.sourceOffset >= 2)).toEqual(
      changed.filter((sample) => sample.sourceOffset >= 2),
    )
  })

  it('treats an unlocked closed seam cyclically while open endpoints remain exact locks', () => {
    const source = [point(0, 0), point(3, 0), point(3, 3), point(0, 3)]
    const closed = shapeTerrainCurve(source, true, WATER_PROFILE, 7)
    const open = shapeTerrainCurve(source, false, WATER_PROFILE, 7)
    const closedSeamGap = distance(
      required(closed.at(-1), 'Closed curve end is missing.'),
      required(closed[0], 'Closed curve start is missing.'),
    )

    expect(closed[0]?.locked).toBe(false)
    expect(closedSeamGap).toBeLessThanOrEqual(WATER_PROFILE.sampleSpacingCells * 1.1)
    expect(open[0]).toMatchObject({ x: 0, y: 0, sourceOffset: 0, locked: true })
    expect(open.at(-1)).toMatchObject({ x: 0, y: 3, locked: true })
  })

  it('uses shortest circular neighborhoods independently of a short closed curve seam', () => {
    const source = [point(0, 0), point(1, 0), point(1, 1), point(0, 1)]
    const profile = {
      ...BASE_PROFILE,
      macroWindowCells: 4,
      fairingRadiusCells: 2.5,
    }
    const shaped = shapeTerrainCurve(source, true, profile, 11)
    const rotatedSource = [
      ...source.slice(1),
      required(source[0], 'Square start point is missing.'),
    ]
    const rotated = shapeTerrainCurve(rotatedSource, true, profile, 11)
    const reversed = shapeTerrainCurve(
      [required(source[0], 'Square start point is missing.'), ...source.slice(1).reverse()],
      true,
      profile,
      11,
    )
    const topMiddle = required(
      shaped.find((sample) => sample.sourceOffset === 0.5),
      'Shaped top midpoint is missing.',
    )

    expect(topMiddle.x).toBeCloseTo(0.5, 12)
    expect(canonicalCoordinates(rotated)).toEqual(canonicalCoordinates(shaped))
    expect(canonicalCoordinates(reversed)).toEqual(canonicalCoordinates(shaped))
    expect(shapeTerrainCurve(source, true, profile, 11)).toEqual(shaped)
  })

  it('leaves resampled geometry unchanged when macro, fairing, and noise are disabled', () => {
    const source = [point(0, 0), point(1, 0), point(1, 1), point(2, 1)]
    const shaped = shapeTerrainCurve(source, false, BASE_PROFILE, 0)

    expect(shaped.map(({ x, y }) => [x, y])).toEqual([
      [0, 0],
      [0.25, 0],
      [0.5, 0],
      [0.75, 0],
      [1, 0],
      [1, 0.25],
      [1, 0.5],
      [1, 0.75],
      [1, 1],
      [1.25, 1],
      [1.5, 1],
      [1.75, 1],
      [2, 1],
    ])
  })

  it('uses the water macro profile to suppress repeated staircase cadence', () => {
    const source = staircase(24)
    const local = shapeTerrainCurve(
      source,
      false,
      {
        ...WATER_PROFILE,
        macroWindowCells: 0,
        fairingIterations: 2,
        fairingRadiusCells: 1,
        fairingStrength: 0.35,
      },
      5,
    )
    const water = shapeTerrainCurve(source, false, WATER_PROFILE, 5)

    expect(cadence(local)).toBeGreaterThan(10)
    expect(cadence(water)).toBeLessThan(cadence(local) / 2)
    expect(curvatureEnergy(water)).toBeLessThan(curvatureEnergy(local) * 0.55)
  })

  it('moves noisy points only along the normal of the faired curve', () => {
    const source = [point(0, 0), point(12, 0)]
    const withoutNoise = shapeTerrainCurve(source, false, BASE_PROFILE, 123)
    const withNoise = shapeTerrainCurve(
      source,
      false,
      { ...BASE_PROFILE, noiseAmplitudeCells: 0.2, noiseWavelengthCells: [4, 4] },
      123,
    )

    for (let index = 1; index < withNoise.length - 1; index += 1) {
      expect(required(withNoise[index], 'Noisy curve point is missing.').x).toBeCloseTo(
        required(withoutNoise[index], 'Quiet curve point is missing.').x,
        12,
      )
    }
    expect(
      withNoise.some(
        (sample, index) =>
          sample.y !== required(withoutNoise[index], 'Quiet curve point is missing.').y,
      ),
    ).toBe(true)
  })

  it('emits strictly monotonic source offsets without duplicating a closed seam', () => {
    for (const [source, closed] of [
      [[point(0, 0), point(1.3, 0), point(1.3, 2)], false] as const,
      [[point(0, 0), point(1.3, 0), point(1.3, 2), point(0, 2)], true] as const,
    ]) {
      const shaped = shapeTerrainCurve(source, closed, WATER_PROFILE, 1)
      expect(
        shaped.every(
          (sample, index) =>
            index === 0 ||
            sample.sourceOffset >
              required(shaped[index - 1], 'Previous curve offset is missing.').sourceOffset,
        ),
      ).toBe(true)
      expect(shaped[0]?.sourceOffset).toBe(0)
      if (closed) expect(shaped.at(-1)?.sourceOffset).toBeLessThan(curveLength(source, true))
      else expect(shaped.at(-1)?.sourceOffset).toBeCloseTo(curveLength(source, false), 12)
    }
  })

  it('shapes a 120 by 120 serpentine source within a bounded linear-time budget', () => {
    const source: TerrainCurveSourcePoint[] = []
    for (let row = 0; row < 120; row += 1) {
      const columns = Array.from({ length: 120 }, (_, column) => column)
      if (row % 2 === 1) columns.reverse()
      for (const column of columns) source.push(point(column, row))
    }
    const profile = {
      ...WATER_PROFILE,
      sampleSpacingCells: 0.5,
      macroWindowCells: 2,
      fairingIterations: 2,
      fairingRadiusCells: 1.5,
    }
    const startedAt = performance.now()
    const shaped = shapeTerrainCurve(source, false, profile, 77)

    expect(shaped.length).toBeGreaterThan(source.length)
    expect(performance.now() - startedAt).toBeLessThan(5_000)
  }, 10_000)
})

function point(x: number, y: number, locked = false): TerrainCurveSourcePoint {
  return { x, y, locked }
}

function staircase(steps: number): TerrainCurveSourcePoint[] {
  const result = [point(0, 0)]
  for (let step = 0; step < steps; step += 1) {
    result.push(point(step + 1, step), point(step + 1, step + 1))
  }
  return result
}

function cadence(points: readonly TerrainCurvePoint[]): number {
  let count = 0
  for (let index = 1; index < points.length - 1; index += 1) {
    const before = required(points[index - 1], 'Previous cadence point is missing.')
    const point = required(points[index], 'Cadence point is missing.')
    const after = required(points[index + 1], 'Next cadence point is missing.')
    const firstAngle = Math.atan2(point.y - before.y, point.x - before.x)
    const secondAngle = Math.atan2(after.y - point.y, after.x - point.x)
    if (Math.abs(normalizedAngle(secondAngle - firstAngle)) > 0.04) count += 1
  }
  return count
}

function curvatureEnergy(points: readonly TerrainCurvePoint[]): number {
  let total = 0
  for (let index = 1; index < points.length - 1; index += 1) {
    const before = required(points[index - 1], 'Previous curvature point is missing.')
    const point = required(points[index], 'Curvature point is missing.')
    const after = required(points[index + 1], 'Next curvature point is missing.')
    total += Math.hypot(after.x - 2 * point.x + before.x, after.y - 2 * point.y + before.y)
  }
  return total
}

function normalizedAngle(angle: number): number {
  const turn = (angle + Math.PI) % (Math.PI * 2)
  return (turn < 0 ? turn + Math.PI * 2 : turn) - Math.PI
}

function distance(first: TerrainCurvePoint, second: TerrainCurvePoint): number {
  return Math.hypot(second.x - first.x, second.y - first.y)
}

function curveLength(points: readonly TerrainCurveSourcePoint[], closed: boolean): number {
  const openLength = points.slice(1).reduce((total, point, index) => {
    const previous = required(points[index], 'Previous source point is missing.')
    return total + Math.hypot(point.x - previous.x, point.y - previous.y)
  }, 0)
  if (!closed) return openLength
  const first = required(points[0], 'First source point is missing.')
  const last = required(points.at(-1), 'Last source point is missing.')
  return openLength + Math.hypot(last.x - first.x, last.y - first.y)
}

function canonicalCoordinates(points: readonly TerrainCurvePoint[]): readonly string[] {
  return points.map((point) => `${point.x.toFixed(12)}:${point.y.toFixed(12)}`).sort()
}

function required<Value>(value: Value | undefined, message: string): Value {
  if (value === undefined) throw new Error(message)
  return value
}
