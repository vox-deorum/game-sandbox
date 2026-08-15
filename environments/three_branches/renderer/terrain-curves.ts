/** Pure, deterministic curve shaping shared by terrain partitions and inset routes. */

import { avalanche, distance, hashUnit, stableHashParts } from '@renderers/base/math.js'

import { required } from './terrain-helpers.js'
import type {
  TerrainCurveEnvelope,
  TerrainCurvePoint,
  TerrainCurveProfile,
  TerrainCurveSourcePoint,
} from './types.js'

const EPSILON = 1e-9
const OFFSET_DIGITS = 12

/**
 * Heavy smoothing flattens junction approaches onto their pinned locks. The shape near a lock
 * blends back toward this low-pass snapshot so approaches keep a natural, lightly rounded form.
 */
const LOCK_BLEND_SNAPSHOT_PASSES = 12

/** Arc reach, in cells, when measuring displacement against the local source polyline. */
const SOURCE_DISTANCE_WINDOW_CELLS = 2.5

interface SourceIndex {
  readonly points: readonly TerrainCurveSourcePoint[]
  readonly offsets: readonly number[]
  readonly totalLength: number
  readonly closed: boolean
}

interface WorkingPoint extends TerrainCurvePoint {
  readonly rawX: number
  readonly rawY: number
}

/**
 * Resample and shape one open or closed polyline without applying topology or clearance policy.
 * Smoothing is a fixed three-point corner kernel run on the resampled points, so every sample
 * keeps its raw source offset and locked points stay exactly in place. Multi-octave value noise
 * then displaces free points along the local normal, scaled down by the envelope ceiling and by
 * arc distance to the nearest lock. Callers remain responsible for accepting, clipping, or
 * backing off the returned candidates.
 */
export function shapeTerrainCurve(
  source: readonly TerrainCurveSourcePoint[],
  closed: boolean,
  profile: TerrainCurveProfile,
  seed: number,
  envelope?: TerrainCurveEnvelope,
): readonly TerrainCurvePoint[] {
  const index = validateInputs(source, closed, profile, seed)
  const samples = resample(index, profile.sampleSpacingCells)
  const lockDistances = arcDistancesToLocks(samples, index.totalLength, closed)
  let positions = samples.map(({ rawX, rawY }) => ({ x: rawX, y: rawY }))

  const passes = closed
    ? Math.min(profile.smoothingPasses, Math.ceil((samples.length * samples.length) / 90))
    : profile.smoothingPasses
  let lowPassSnapshot: typeof positions | undefined
  for (let pass = 0; pass < passes; pass += 1) {
    const current = positions
    positions = samples.map((sample, sampleIndex) => {
      const point = required(current[sampleIndex], 'Terrain curve smoothing point is missing.')
      if (sample.locked) return { x: sample.rawX, y: sample.rawY }
      const beforeIndex = previousIndex(sampleIndex, samples.length, closed)
      const afterIndex = nextIndex(sampleIndex, samples.length, closed)
      if (beforeIndex === sampleIndex || afterIndex === sampleIndex) return point
      const before = required(current[beforeIndex], 'Terrain curve smoothing neighbor is missing.')
      const after = required(current[afterIndex], 'Terrain curve smoothing neighbor is missing.')
      return {
        x: point.x * 0.5 + (before.x + after.x) * 0.25,
        y: point.y * 0.5 + (before.y + after.y) * 0.25,
      }
    })
    if (pass + 1 === LOCK_BLEND_SNAPSHOT_PASSES) lowPassSnapshot = positions
  }
  if (lowPassSnapshot !== undefined && passes > LOCK_BLEND_SNAPSHOT_PASSES) {
    const snapshot = lowPassSnapshot
    const sigmaCells = profile.sampleSpacingCells * Math.sqrt(passes / 2)
    const blendRadius = 3 * sigmaCells
    positions = positions.map((point, sampleIndex) => {
      const sample = required(samples[sampleIndex], 'Terrain curve blend sample is missing.')
      if (sample.locked) return { x: sample.rawX, y: sample.rawY }
      const lockDistance = required(
        lockDistances[sampleIndex],
        'Terrain curve lock distance is missing.',
      )
      const amount = smoothstep(Math.min(1, lockDistance / blendRadius))
      if (amount >= 1) return point
      const low = required(snapshot[sampleIndex], 'Terrain curve blend snapshot is missing.')
      return {
        x: low.x + (point.x - low.x) * amount,
        y: low.y + (point.y - low.y) * amount,
      }
    })
  }

  const totalAmplitude = profile.octaves.reduce((sum, octave) => sum + octave.amplitudeCells, 0)
  if (totalAmplitude > EPSILON && samples.length > 2) {
    const beforeNoise = positions
    positions = samples.map((sample, sampleIndex) => {
      const point = required(beforeNoise[sampleIndex], 'Terrain curve noise point is missing.')
      if (sample.locked) return { x: sample.rawX, y: sample.rawY }
      const ceiling = Math.min(
        envelope?.(sample.rawX, sample.rawY, sample.sourceOffset) ?? Number.POSITIVE_INFINITY,
        required(lockDistances[sampleIndex], 'Terrain curve lock distance is missing.'),
      )
      const used = distanceToSource(index, point.x, point.y, sample.sourceOffset)
      const room = ceiling - used
      if (room <= EPSILON) return point
      const beforeIndex = previousIndex(sampleIndex, samples.length, closed)
      const afterIndex = nextIndex(sampleIndex, samples.length, closed)
      const before = beforeNoise[beforeIndex] ?? point
      const after = beforeNoise[afterIndex] ?? point
      const dx = after.x - before.x
      const dy = after.y - before.y
      const tangentLength = Math.hypot(dx, dy)
      if (tangentLength <= EPSILON) return point
      let noise = 0
      for (const [octaveIndex, octave] of profile.octaves.entries()) {
        noise +=
          smoothValueNoise(
            avalanche(stableHashParts(seed, 'octave', octaveIndex)),
            point.x / octave.wavelengthCells,
            point.y / octave.wavelengthCells,
          ) * octave.amplitudeCells
      }
      const scale = Math.min(1, room / totalAmplitude)
      return {
        x: point.x + (-dy / tangentLength) * noise * scale,
        y: point.y + (dx / tangentLength) * noise * scale,
      }
    })
  }

  return samples.map((sample, sampleIndex) => ({
    x: required(positions[sampleIndex], 'Terrain curve result point is missing.').x,
    y: required(positions[sampleIndex], 'Terrain curve result point is missing.').y,
    sourceOffset: sample.sourceOffset,
    locked: sample.locked,
  }))
}

function validateInputs(
  source: readonly TerrainCurveSourcePoint[],
  closed: boolean,
  profile: TerrainCurveProfile,
  seed: number,
): SourceIndex {
  if (typeof closed !== 'boolean') throw new Error('Terrain curve closed must be a boolean.')
  const minimumPoints = closed ? 3 : 2
  if (!Array.isArray(source) || source.length < minimumPoints) {
    throw new Error(`Terrain curve requires at least ${minimumPoints} source points.`)
  }
  if (!Number.isFinite(seed) || !Number.isInteger(seed)) {
    throw new Error('Terrain curve seed must be a finite integer.')
  }
  bounded(profile.sampleSpacingCells, 0, 4, 'sample spacing')
  if (
    !Number.isInteger(profile.smoothingPasses) ||
    profile.smoothingPasses < 0 ||
    profile.smoothingPasses > 256
  ) {
    throw new Error('Terrain curve smoothing passes must be an integer between zero and 256.')
  }
  if (!Array.isArray(profile.octaves) || profile.octaves.length > 8) {
    throw new Error('Terrain curve octaves must be a list of at most eight bands.')
  }
  for (const octave of profile.octaves) {
    bounded(octave.wavelengthCells, 0, 256, 'octave wavelength')
    bounded(octave.amplitudeCells, 0, 4, 'octave amplitude', true)
  }

  const offsets = [0]
  let totalLength = 0
  for (let pointIndex = 0; pointIndex < source.length; pointIndex += 1) {
    const point = required(source[pointIndex], 'Validated terrain curve point is missing.')
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      typeof point.locked !== 'boolean'
    ) {
      throw new Error(`Terrain curve source point ${pointIndex} is invalid.`)
    }
    if (pointIndex === 0) continue
    const length = distance(
      required(source[pointIndex - 1], 'Previous terrain curve point is missing.'),
      point,
    )
    if (length <= EPSILON) {
      throw new Error('Terrain curve source contains consecutive duplicate points.')
    }
    totalLength += length
    offsets.push(totalLength)
  }
  if (closed) {
    const seamLength = distance(
      required(source.at(-1), 'Closed terrain curve end is missing.'),
      required(source[0], 'Closed terrain curve start is missing.'),
    )
    if (seamLength <= EPSILON) {
      throw new Error('Closed terrain curve repeats its first point at the seam.')
    }
    totalLength += seamLength
  }
  return { points: source, offsets, totalLength, closed }
}

function bounded(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
  allowMinimum = false,
): void {
  if (
    !Number.isFinite(value) ||
    (allowMinimum ? value < minimum : value <= minimum) ||
    value > maximum
  ) {
    throw new Error(
      `Terrain curve ${label} must be ${allowMinimum ? 'between' : 'greater than'} ${minimum} and at most ${maximum}.`,
    )
  }
}

function resample(index: SourceIndex, spacing: number): WorkingPoint[] {
  const offsets = new Map<string, number>()
  const addOffset = (offset: number): void => {
    const normalized = index.closed ? normalizeOffset(offset, index.totalLength) : offset
    offsets.set(offsetKey(normalized), normalized)
  }
  const sampleCount = Math.ceil(index.totalLength / spacing)
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    addOffset(sampleIndex * spacing)
  }
  for (const offset of index.offsets) addOffset(offset)
  if (!index.closed) addOffset(index.totalLength)

  const lockedOffsets = new Set<string>()
  index.points.forEach((point, pointIndex) => {
    if (
      point.locked ||
      (!index.closed && (pointIndex === 0 || pointIndex === index.points.length - 1))
    ) {
      lockedOffsets.add(
        offsetKey(required(index.offsets[pointIndex], 'Terrain curve source offset is missing.')),
      )
    }
  })

  return [...offsets.values()]
    .sort((first, second) => first - second)
    .map((sourceOffset) => {
      const raw = pointAtOffset(index, sourceOffset)
      return {
        x: raw.x,
        y: raw.y,
        rawX: raw.x,
        rawY: raw.y,
        sourceOffset,
        locked: lockedOffsets.has(offsetKey(sourceOffset)),
      }
    })
}

function pointAtOffset(
  index: SourceIndex,
  offset: number,
): { readonly x: number; readonly y: number } {
  const normalized = index.closed ? normalizeOffset(offset, index.totalLength) : offset
  if (!index.closed && normalized >= index.totalLength - EPSILON) {
    const last = required(index.points.at(-1), 'Open terrain curve end is missing.')
    return { x: last.x, y: last.y }
  }
  let upper = index.offsets.length
  let lower = 0
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2)
    if (
      required(index.offsets[middle], 'Terrain curve search offset is missing.') >
      normalized + EPSILON
    ) {
      upper = middle
    } else lower = middle + 1
  }
  const startIndex = Math.min(index.points.length - 1, Math.max(0, lower - 1))
  const endIndex = (startIndex + 1) % index.points.length
  const startOffset = required(index.offsets[startIndex], 'Terrain curve start offset is missing.')
  const endOffset =
    endIndex === 0
      ? index.totalLength
      : required(index.offsets[endIndex], 'Terrain curve end offset is missing.')
  const amount = Math.max(0, Math.min(1, (normalized - startOffset) / (endOffset - startOffset)))
  const start = required(index.points[startIndex], 'Terrain curve segment start is missing.')
  const end = required(index.points[endIndex], 'Terrain curve segment end is missing.')
  return { x: start.x + (end.x - start.x) * amount, y: start.y + (end.y - start.y) * amount }
}

function smoothstep(value: number): number {
  const clamped = Math.max(0, Math.min(1, value))
  return clamped * clamped * (3 - 2 * clamped)
}

/**
 * Arc-windowed distance from a shaped position to the source polyline around one offset. Only
 * segments within the window count, so a fold-back elsewhere on the curve never masks how far
 * the position really sits from its own local stretch of the source.
 */
function distanceToSource(index: SourceIndex, x: number, y: number, sourceOffset: number): number {
  const pointCount = index.points.length
  const segmentCount = index.closed ? pointCount : pointCount - 1
  if (segmentCount <= 0) return 0
  const segmentStart = (segment: number): number =>
    required(index.offsets[segment], 'Terrain curve segment start offset is missing.')
  const segmentEnd = (segment: number): number =>
    segment + 1 < index.offsets.length
      ? required(index.offsets[segment + 1], 'Terrain curve segment end offset is missing.')
      : index.totalLength
  const separationFrom = (segment: number): number => {
    const start = required(index.points[segment], 'Terrain curve segment start is missing.')
    const end = required(
      index.points[(segment + 1) % pointCount],
      'Terrain curve segment end is missing.',
    )
    const dx = end.x - start.x
    const dy = end.y - start.y
    const lengthSquared = dx * dx + dy * dy
    if (lengthSquared <= EPSILON) return Math.hypot(x - start.x, y - start.y)
    const amount = Math.max(
      0,
      Math.min(1, ((x - start.x) * dx + (y - start.y) * dy) / lengthSquared),
    )
    return Math.hypot(x - (start.x + dx * amount), y - (start.y + dy * amount))
  }
  let lower = 0
  let upper = segmentCount - 1
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2)
    if (segmentEnd(middle) > sourceOffset + EPSILON) upper = middle
    else lower = middle + 1
  }
  let nearest = separationFrom(lower)
  for (const direction of [-1, 1] as const) {
    let segment = lower
    let coverage = 0
    for (let step = 0; step < segmentCount - 1; step += 1) {
      let next = segment + direction
      if (index.closed) next = (next + segmentCount) % segmentCount
      else if (next < 0 || next >= segmentCount) break
      coverage += Math.max(0, segmentEnd(next) - segmentStart(next))
      segment = next
      nearest = Math.min(nearest, separationFrom(segment))
      if (coverage >= SOURCE_DISTANCE_WINDOW_CELLS) break
    }
  }
  return nearest
}

/** Arc distance from each sample to its nearest locked sample, infinite when nothing is locked. */
function arcDistancesToLocks(
  samples: readonly WorkingPoint[],
  totalLength: number,
  closed: boolean,
): number[] {
  const distances = samples.map((sample) => (sample.locked ? 0 : Number.POSITIVE_INFINITY))
  if (!distances.includes(0)) return distances
  const count = samples.length
  const forwardGap = (fromIndex: number): number => {
    const from = required(samples[fromIndex], 'Terrain curve gap start is missing.').sourceOffset
    if (fromIndex + 1 < count) {
      return (
        required(samples[fromIndex + 1], 'Terrain curve gap end is missing.').sourceOffset - from
      )
    }
    return (
      totalLength - from + required(samples[0], 'Terrain curve gap end is missing.').sourceOffset
    )
  }
  const rounds = closed ? 2 : 1
  for (let round = 0; round < rounds; round += 1) {
    for (let sampleIndex = 0; sampleIndex < count; sampleIndex += 1) {
      if (!closed && sampleIndex + 1 >= count) break
      const target = (sampleIndex + 1) % count
      const candidate =
        required(distances[sampleIndex], 'Lock distance is missing.') + forwardGap(sampleIndex)
      if (candidate < required(distances[target], 'Lock distance is missing.')) {
        distances[target] = candidate
      }
    }
    for (let sampleIndex = count - 1; sampleIndex >= 0; sampleIndex -= 1) {
      if (!closed && sampleIndex + 1 >= count) continue
      const target = (sampleIndex + 1) % count
      const candidate =
        required(distances[target], 'Lock distance is missing.') + forwardGap(sampleIndex)
      if (candidate < required(distances[sampleIndex], 'Lock distance is missing.')) {
        distances[sampleIndex] = candidate
      }
    }
  }
  return distances
}

function previousIndex(index: number, length: number, closed: boolean): number {
  if (index > 0) return index - 1
  return closed ? length - 1 : index
}

function nextIndex(index: number, length: number, closed: boolean): number {
  if (index + 1 < length) return index + 1
  return closed ? 0 : index
}

function smoothValueNoise(seed: number, x: number, y: number): number {
  const column = Math.floor(x)
  const row = Math.floor(y)
  const localX = x - column
  const localY = y - row
  const fade = (value: number): number => value * value * (3 - 2 * value)
  const valueAt = (offsetX: number, offsetY: number): number =>
    hashUnit(
      avalanche(stableHashParts(seed, 'curve-noise', column + offsetX, row + offsetY)),
    ) *
      2 -
    1
  const blendX = fade(localX)
  const blendY = fade(localY)
  const north = valueAt(0, 0) + (valueAt(1, 0) - valueAt(0, 0)) * blendX
  const south = valueAt(0, 1) + (valueAt(1, 1) - valueAt(0, 1)) * blendX
  return north + (south - north) * blendY
}

function normalizeOffset(offset: number, totalLength: number): number {
  const normalized = offset % totalLength
  return normalized < 0 ? normalized + totalLength : normalized
}

function offsetKey(offset: number): string {
  return offset.toFixed(OFFSET_DIGITS)
}
