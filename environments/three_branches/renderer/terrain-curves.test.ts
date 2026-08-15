import { describe, expect, it } from 'vitest'

import { shapeTerrainCurve } from './terrain-curves.js'
import type {
  TerrainCurvePoint,
  TerrainCurveProfile,
  TerrainCurveSourcePoint,
} from './types.js'

const BASE_PROFILE: TerrainCurveProfile = {
  sampleSpacingCells: 0.25,
  smoothingPasses: 0,
  octaves: [],
}

const SMOOTH_PROFILE: TerrainCurveProfile = {
  sampleSpacingCells: 0.2,
  smoothingPasses: 6,
  octaves: [],
}

const SHAPED_PROFILE: TerrainCurveProfile = {
  sampleSpacingCells: 0.2,
  smoothingPasses: 6,
  octaves: [
    { wavelengthCells: 7, amplitudeCells: 0.08 },
    { wavelengthCells: 12, amplitudeCells: 0.05 },
  ],
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
      [{ smoothingPasses: -1 }, 'smoothing passes'],
      [{ smoothingPasses: 1.5 }, 'smoothing passes'],
      [{ smoothingPasses: 257 }, 'between zero and 256'],
      [
        { octaves: Array.from({ length: 9 }, () => ({ wavelengthCells: 4, amplitudeCells: 0.1 })) },
        'at most eight bands',
      ],
      [{ octaves: [{ wavelengthCells: 0, amplitudeCells: 0.1 }] }, 'octave wavelength'],
      [{ octaves: [{ wavelengthCells: 4, amplitudeCells: -0.01 }] }, 'octave amplitude'],
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

    expect(shapeTerrainCurve(open, false, SHAPED_PROFILE, 42)).toEqual(
      shapeTerrainCurve(open, false, SHAPED_PROFILE, 42),
    )
    expect(shapeTerrainCurve(closed, true, SHAPED_PROFILE, 42)).toEqual(
      shapeTerrainCurve(closed, true, SHAPED_PROFILE, 42),
    )
    expect(shapeTerrainCurve(open, false, SHAPED_PROFILE, 42)).not.toEqual(
      shapeTerrainCurve(open, false, SHAPED_PROFILE, 43),
    )
  })

  it('keeps locks exact and prevents either free interval from sampling across them', () => {
    const first = [point(-1, 1), point(0, 1), point(1, 1, true), point(2, 1), point(3, 1)]
    const changedLeft = [point(1, -1), point(1, 0), point(1, 1, true), point(2, 1), point(3, 1)]
    const shaped = shapeTerrainCurve(first, false, SHAPED_PROFILE, 19)
    const changed = shapeTerrainCurve(changedLeft, false, SHAPED_PROFILE, 19)
    const lock = shaped.find((sample) => sample.locked && sample.sourceOffset === 2)

    expect(lock).toEqual({ x: 1, y: 1, sourceOffset: 2, locked: true })
    expect(shaped.filter((sample) => sample.sourceOffset >= 2)).toEqual(
      changed.filter((sample) => sample.sourceOffset >= 2),
    )
  })

  it('treats an unlocked closed seam cyclically while open endpoints remain exact locks', () => {
    const source = [point(0, 0), point(3, 0), point(3, 3), point(0, 3)]
    const closed = shapeTerrainCurve(source, true, SMOOTH_PROFILE, 7)
    const open = shapeTerrainCurve(source, false, SMOOTH_PROFILE, 7)
    const closedSeamGap = distance(
      required(closed.at(-1), 'Closed curve end is missing.'),
      required(closed[0], 'Closed curve start is missing.'),
    )

    expect(closed[0]?.locked).toBe(false)
    expect(closedSeamGap).toBeLessThanOrEqual(SMOOTH_PROFILE.sampleSpacingCells * 1.1)
    expect(open[0]).toMatchObject({ x: 0, y: 0, sourceOffset: 0, locked: true })
    expect(open.at(-1)).toMatchObject({ x: 0, y: 3, locked: true })
  })

  it('leaves resampled geometry unchanged when smoothing and octaves are disabled', () => {
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

  it('moves noisy points only along the local normal of the curve', () => {
    const source = [point(0, 0), point(12, 0)]
    const withoutNoise = shapeTerrainCurve(source, false, BASE_PROFILE, 123)
    const withNoise = shapeTerrainCurve(
      source,
      false,
      { ...BASE_PROFILE, octaves: [{ wavelengthCells: 4, amplitudeCells: 0.2 }] },
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

  it('caps free point displacement at the envelope ceiling', () => {
    const source = [point(0, 0), point(10, 0)]
    const profile: TerrainCurveProfile = {
      sampleSpacingCells: 0.5,
      smoothingPasses: 0,
      octaves: [{ wavelengthCells: 3, amplitudeCells: 4 }],
    }
    const shaped = shapeTerrainCurve(source, false, profile, 5, () => 0.1)

    for (const sample of shaped) {
      if (sample.locked) continue
      const displacement = Math.hypot(sample.x - sample.sourceOffset, sample.y)
      expect(displacement).toBeLessThanOrEqual(0.1 + 1e-6)
    }
  })

  it('emits strictly monotonic source offsets without duplicating a closed seam', () => {
    for (const [source, closed] of [
      [[point(0, 0), point(1.3, 0), point(1.3, 2)], false] as const,
      [[point(0, 0), point(1.3, 0), point(1.3, 2), point(0, 2)], true] as const,
    ]) {
      const shaped = shapeTerrainCurve(source, closed, SMOOTH_PROFILE, 1)
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
    const profile: TerrainCurveProfile = { ...SHAPED_PROFILE, sampleSpacingCells: 0.5 }
    const startedAt = performance.now()
    const shaped = shapeTerrainCurve(source, false, profile, 77)

    expect(shaped.length).toBeGreaterThan(source.length)
    expect(performance.now() - startedAt).toBeLessThan(5_000)
  }, 10_000)
})

function point(x: number, y: number, locked = false): TerrainCurveSourcePoint {
  return { x, y, locked }
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

function required<Value>(value: Value | undefined, message: string): Value {
  if (value === undefined) throw new Error(message)
  return value
}
