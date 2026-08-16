/** Pure, deterministic curve shaping shared by terrain partitions and inset routes. */

import { distance, hashUnit, stableHashParts } from '@renderers/base/math.js'

import { required } from './terrain-helpers.js'
import type {
  TerrainCurveBudget,
  TerrainCurvePoint,
  TerrainCurveProfile,
  TerrainCurveSourcePoint,
} from './types.js'

const EPSILON = 1e-9
const OFFSET_DIGITS = 12

/** Arc reach, in cells, when measuring displacement against the local source polyline. */
const SOURCE_DISTANCE_WINDOW_CELLS = 2.5

/** Most smoothing passes one curve may run, which is what bounds the cost of a corner radius. */
const MAX_SMOOTHING_PASSES = 256

/**
 * Smoothing passes that round a corner over the radius the profile asks for.
 *
 * The three-point kernel spreads a sample's influence the way diffusion spreads heat, so successive
 * passes add in quadrature and the radius they round to grows as the square root of their count:
 * `radius = spacing * sqrt(passes / 2)`. Inverting that leaves the corner shape a distance the
 * caller sets, rather than something that quietly changes whenever the sample spacing moves.
 */
export function smoothingPassesFor(profile: TerrainCurveProfile, label: string): number {
  const passes = Math.round(2 * (profile.cornerRadiusCells / profile.sampleSpacingCells) ** 2)
  if (passes > MAX_SMOOTHING_PASSES) {
    throw new Error(
      `${label} corner radius needs ${passes} smoothing passes at that sample spacing, ` +
        `more than the ${MAX_SMOOTHING_PASSES} allowed.`,
    )
  }
  return passes
}

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
 * Resample and shape one open or closed polyline without applying topology policy.
 * Smoothing is a three-point corner kernel run over as many passes as the profile's corner radius
 * calls for, so every sample keeps its raw source offset and locked points stay exactly in place.
 * Multi-octave value noise then displaces free points along the local normal by the amplitude each
 * octave asks for.
 *
 * The optional budget bounds how far each sample may leave the source curve, and bounds both
 * stages: smoothing is pulled back to it before noise runs, and the total is pulled back again
 * after. A caller that varies its budget smoothly along the arc therefore gets a smooth curve,
 * where clamping the finished curve instead would kink it wherever the bound stepped between
 * neighbouring samples.
 */
export function shapeTerrainCurve(
  source: readonly TerrainCurveSourcePoint[],
  closed: boolean,
  profile: TerrainCurveProfile,
  seed: number,
  budget?: TerrainCurveBudget,
): readonly TerrainCurvePoint[] {
  const index = validateInputs(source, closed, profile, seed)
  const samples = resample(index, profile.sampleSpacingCells)
  const lockDistances = arcDistancesToLocks(samples, index.totalLength, closed)
  let positions = samples.map(({ rawX, rawY }) => ({ x: rawX, y: rawY }))

  const requested = smoothingPassesFor(profile, 'Terrain curve')
  const passes = closed
    ? Math.min(requested, Math.ceil((samples.length * samples.length) / 90))
    : requested
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
  }

  const ceilingAt = (sampleIndex: number, sample: WorkingPoint): number =>
    Math.min(
      budget?.(sample.sourceOffset) ?? Number.POSITIVE_INFINITY,
      required(lockDistances[sampleIndex], 'Terrain curve lock distance is missing.'),
    )

  /**
   * Pull every free sample back onto its ceiling, contracting toward the point of the source it
   * strayed from. Contracting toward the sample's own source position instead mixes the distance
   * that has to be bounded with the tangential slide that does not, so it lands past the ceiling
   * by however far the sample slid, and a corridor gives up that much on each of its two sides.
   */
  const withinCeiling = (
    current: readonly { readonly x: number; readonly y: number }[],
  ): { x: number; y: number }[] =>
    samples.map((sample, sampleIndex) => {
      const point = required(current[sampleIndex], 'Terrain curve ceiling point is missing.')
      if (sample.locked) return { x: point.x, y: point.y }
      const ceiling = ceilingAt(sampleIndex, sample)
      if (!Number.isFinite(ceiling)) return { x: point.x, y: point.y }
      const { distance: strayed, foot } = nearestSource(
        index,
        point.x,
        point.y,
        sample.sourceOffset,
      )
      if (strayed <= ceiling) return { x: point.x, y: point.y }
      const scale = ceiling / strayed
      return {
        x: foot.x + (point.x - foot.x) * scale,
        y: foot.y + (point.y - foot.y) * scale,
      }
    })

  positions = withinCeiling(positions)

  const displaces = profile.octaves.some((octave) => octave.amplitudeCells > EPSILON)
  if (displaces && samples.length > 2) {
    const beforeNoise = positions
    positions = samples.map((sample, sampleIndex) => {
      const point = required(beforeNoise[sampleIndex], 'Terrain curve noise point is missing.')
      if (sample.locked) return { x: sample.rawX, y: sample.rawY }
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
            stableHashParts(seed, 'octave', octaveIndex),
            point.x / octave.wavelengthCells,
            point.y / octave.wavelengthCells,
          ) * octave.amplitudeCells
      }
      // Each octave displaces by the distance it was configured for, and where the room runs out
      // the total gives way to it smoothly. Two earlier ways of doing this both misbehaved:
      // scaling the octaves by the ceiling over their own sum divided out the very amplitudes it
      // multiplied by, leaving the configuration inert, and clipping at the ceiling left the
      // boundary running along its bound and turning a corner every time the noise changed sign.
      const room = ceilingAt(sampleIndex, sample)
      if (room <= EPSILON) return point
      const moved = Number.isFinite(room) ? room * Math.tanh(noise / room) : noise
      return {
        x: point.x + (-dy / tangentLength) * moved,
        y: point.y + (dx / tangentLength) * moved,
      }
    })
    positions = withinCeiling(positions)
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
  bounded(profile.cornerRadiusCells, 0, 4, 'corner radius', true)
  smoothingPassesFor(profile, 'Terrain curve')
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

/**
 * Nearest point on the source polyline to a shaped position, searched over an arc window around
 * the position's own offset. Only segments within the window count, so a fold-back elsewhere on
 * the curve never masks how far the position really sits from its own local stretch of source.
 */
function nearestSource(
  index: SourceIndex,
  x: number,
  y: number,
  sourceOffset: number,
): { readonly distance: number; readonly foot: { readonly x: number; readonly y: number } } {
  const pointCount = index.points.length
  const segmentCount = index.closed ? pointCount : pointCount - 1
  if (segmentCount <= 0) return { distance: 0, foot: { x, y } }
  const segmentStart = (segment: number): number =>
    required(index.offsets[segment], 'Terrain curve segment start offset is missing.')
  const segmentEnd = (segment: number): number =>
    segment + 1 < index.offsets.length
      ? required(index.offsets[segment + 1], 'Terrain curve segment end offset is missing.')
      : index.totalLength
  const footOn = (segment: number): { distance: number; foot: { x: number; y: number } } => {
    const start = required(index.points[segment], 'Terrain curve segment start is missing.')
    const end = required(
      index.points[(segment + 1) % pointCount],
      'Terrain curve segment end is missing.',
    )
    const dx = end.x - start.x
    const dy = end.y - start.y
    const lengthSquared = dx * dx + dy * dy
    const amount =
      lengthSquared <= EPSILON
        ? 0
        : Math.max(0, Math.min(1, ((x - start.x) * dx + (y - start.y) * dy) / lengthSquared))
    const foot = { x: start.x + dx * amount, y: start.y + dy * amount }
    return { distance: Math.hypot(x - foot.x, y - foot.y), foot }
  }
  let lower = 0
  let upper = segmentCount - 1
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2)
    if (segmentEnd(middle) > sourceOffset + EPSILON) upper = middle
    else lower = middle + 1
  }
  let nearest = footOn(lower)
  for (const direction of [-1, 1] as const) {
    let segment = lower
    let coverage = 0
    for (let step = 0; step < segmentCount - 1; step += 1) {
      let next = segment + direction
      if (index.closed) next = (next + segmentCount) % segmentCount
      else if (next < 0 || next >= segmentCount) break
      coverage += Math.max(0, segmentEnd(next) - segmentStart(next))
      segment = next
      const candidate = footOn(segment)
      if (candidate.distance < nearest.distance) nearest = candidate
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
  const locks = samples.filter((sample) => sample.locked).map((sample) => sample.sourceOffset)
  if (locks.length === 0) return samples.map(() => Number.POSITIVE_INFINITY)
  let nextLock = 0
  return samples.map((sample) => {
    while (locks[nextLock] !== undefined && locks[nextLock]! < sample.sourceOffset) nextLock += 1
    const later = locks[nextLock] ?? (closed ? locks[0]! + totalLength : Number.POSITIVE_INFINITY)
    const earlier =
      locks[nextLock - 1] ??
      (closed ? locks[locks.length - 1]! - totalLength : Number.NEGATIVE_INFINITY)
    return Math.min(later - sample.sourceOffset, sample.sourceOffset - earlier)
  })
}

function previousIndex(index: number, length: number, closed: boolean): number {
  if (index > 0) return index - 1
  return closed ? length - 1 : index
}

function nextIndex(index: number, length: number, closed: boolean): number {
  if (index + 1 < length) return index + 1
  return closed ? 0 : index
}

/**
 * Deviation of the raw faded value field, as a fraction of its range.
 *
 * The lattice values are uniform and a point takes a smoothstep blend of the four around it, so
 * the field reaches one only where a sample lands on a lattice corner and sits far inside that
 * everywhere else. Its deviation works out at the square root of a third of the mean squared
 * blend weight, which is close to 0.43, and simulating the field agrees.
 */
const VALUE_NOISE_DEVIATION = 0.43

/**
 * One octave of smooth value noise, carrying the deviation factor so that one unit out is one
 * deviation out. An amplitude in cells then means the distance a boundary usually moves, rather
 * than a peak it reaches on a handful of samples, which is the only reading a caller can act on.
 */
function smoothValueNoise(seed: number, x: number, y: number): number {
  const column = Math.floor(x)
  const row = Math.floor(y)
  const localX = x - column
  const localY = y - row
  const fade = (value: number): number => value * value * (3 - 2 * value)
  const valueAt = (offsetX: number, offsetY: number): number =>
    hashUnit(stableHashParts(seed, 'curve-noise', column + offsetX, row + offsetY)) * 2 - 1
  const blendX = fade(localX)
  const blendY = fade(localY)
  const north = valueAt(0, 0) + (valueAt(1, 0) - valueAt(0, 0)) * blendX
  const south = valueAt(0, 1) + (valueAt(1, 1) - valueAt(0, 1)) * blendX
  return (north + (south - north) * blendY) / VALUE_NOISE_DEVIATION
}

function normalizeOffset(offset: number, totalLength: number): number {
  const normalized = offset % totalLength
  return normalized < 0 ? normalized + totalLength : normalized
}

function offsetKey(offset: number): string {
  return offset.toFixed(OFFSET_DIGITS)
}
