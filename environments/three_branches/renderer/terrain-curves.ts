/** Pure, deterministic curve shaping shared by terrain partitions and inset routes. */

const EPSILON = 1e-9
const OFFSET_DIGITS = 12

/** Geometry controls shared by land, water, road, and path curve profiles. */
export interface TerrainCurveProfile {
  readonly sampleSpacingCells: number
  readonly macroWindowCells: number
  readonly fairingIterations: number
  readonly fairingRadiusCells: number
  readonly fairingStrength: number
  readonly noiseAmplitudeCells: number
  readonly noiseWavelengthCells: readonly [number, number]
}

/** One authored curve point. Locked points split free shaping intervals. */
export interface TerrainCurveSourcePoint {
  readonly x: number
  readonly y: number
  readonly locked: boolean
}

/** One shaped point paired with its monotonic offset on the authored curve. */
export interface TerrainCurvePoint {
  readonly x: number
  readonly y: number
  readonly sourceOffset: number
  readonly locked: boolean
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
 * Resample and shape one open or closed polyline without applying topology or clearance policy.
 * Callers remain responsible for accepting, clipping, or backing off the returned candidates.
 */
export function shapeTerrainCurve(
  source: readonly TerrainCurveSourcePoint[],
  closed: boolean,
  profile: TerrainCurveProfile,
  seed: number,
): readonly TerrainCurvePoint[] {
  const index = validateInputs(source, closed, profile, seed)
  const samples = resample(index, profile.sampleSpacingCells)
  let positions = samples.map(({ rawX, rawY }) => ({ x: rawX, y: rawY }))

  if (profile.macroWindowCells > 0) {
    const rawPositions = positions
    positions = samples.map((sample, sampleIndex) => {
      if (sample.locked) return { x: sample.rawX, y: sample.rawY }
      const neighborhood = triangularMean(
        sampleIndex,
        rawPositions,
        samples,
        index.totalLength,
        closed,
        profile.macroWindowCells,
      )
      const taper = Math.min(1, neighborhood.nearestLock / profile.macroWindowCells)
      return {
        x: sample.rawX + (neighborhood.x - sample.rawX) * taper,
        y: sample.rawY + (neighborhood.y - sample.rawY) * taper,
      }
    })
  }

  for (let iteration = 0; iteration < profile.fairingIterations; iteration += 1) {
    const current = positions
    positions = samples.map((sample, sampleIndex) => {
      if (sample.locked) return { x: sample.rawX, y: sample.rawY }
      const point = required(current[sampleIndex], 'Terrain curve fairing point is missing.')
      const mean = triangularMean(
        sampleIndex,
        current,
        samples,
        index.totalLength,
        closed,
        profile.fairingRadiusCells,
      )
      return {
        x: point.x + (mean.x - point.x) * profile.fairingStrength,
        y: point.y + (mean.y - point.y) * profile.fairingStrength,
      }
    })
  }

  if (profile.noiseAmplitudeCells > 0 && samples.length > 2) {
    const beforeNoise = positions
    const wavelength = interpolateHash(
      hash(seed, 'wavelength'),
      profile.noiseWavelengthCells[0],
      profile.noiseWavelengthCells[1],
    )
    positions = samples.map((sample, sampleIndex) => {
      if (sample.locked) return { x: sample.rawX, y: sample.rawY }
      const beforeIndex = previousIndex(sampleIndex, samples.length, closed)
      const afterIndex = nextIndex(sampleIndex, samples.length, closed)
      const point = required(beforeNoise[sampleIndex], 'Terrain curve noise point is missing.')
      const before = beforeNoise[beforeIndex] ?? point
      const after = beforeNoise[afterIndex] ?? point
      const dx = after.x - before.x
      const dy = after.y - before.y
      const tangentLength = Math.hypot(dx, dy)
      if (tangentLength <= EPSILON) return point
      const noise =
        smoothValueNoise(seed, point.x / wavelength, point.y / wavelength) *
        profile.noiseAmplitudeCells
      return {
        x: point.x + (-dy / tangentLength) * noise,
        y: point.y + (dx / tangentLength) * noise,
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
  bounded(profile.macroWindowCells, 0, 64, 'macro window', true)
  if (
    !Number.isInteger(profile.fairingIterations) ||
    profile.fairingIterations < 0 ||
    profile.fairingIterations > 32
  ) {
    throw new Error('Terrain curve fairing iterations must be an integer between zero and 32.')
  }
  bounded(profile.fairingRadiusCells, 0, 64, 'fairing radius')
  bounded(profile.fairingStrength, 0, 1, 'fairing strength', true)
  bounded(profile.noiseAmplitudeCells, 0, 4, 'noise amplitude', true)
  if (!Array.isArray(profile.noiseWavelengthCells) || profile.noiseWavelengthCells.length !== 2) {
    throw new Error('Terrain curve noise wavelength must contain exactly two values.')
  }
  const [minimumWavelength, maximumWavelength] = profile.noiseWavelengthCells
  bounded(minimumWavelength, 0, 256, 'minimum noise wavelength')
  bounded(maximumWavelength, 0, 256, 'maximum noise wavelength')
  if (minimumWavelength > maximumWavelength) {
    throw new Error('Terrain curve noise wavelength must be ordered.')
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

function triangularMean(
  centerIndex: number,
  positions: readonly { readonly x: number; readonly y: number }[],
  samples: readonly WorkingPoint[],
  totalLength: number,
  closed: boolean,
  radius: number,
): { readonly x: number; readonly y: number; readonly nearestLock: number } {
  const center = required(positions[centerIndex], 'Terrain curve neighborhood center is missing.')
  let weightedX = center.x
  let weightedY = center.y
  let weightTotal = 1
  let nearestLock = Number.POSITIVE_INFINITY
  const neighbors = new Map<number, number>()

  for (const direction of [-1, 1] as const) {
    let cursor = centerIndex
    let offsetDistance = 0
    for (let step = 1; step < samples.length; step += 1) {
      const neighborIndex = cursor + direction
      if (!closed && (neighborIndex < 0 || neighborIndex >= samples.length)) break
      const wrappedIndex = (neighborIndex + samples.length) % samples.length
      offsetDistance += adjacentOffsetDistance(
        samples,
        cursor,
        wrappedIndex,
        direction,
        totalLength,
        closed,
      )
      if (offsetDistance > radius + EPSILON) break
      cursor = wrappedIndex
      const neighborSample = required(
        samples[wrappedIndex],
        'Terrain curve neighborhood sample is missing.',
      )
      if (neighborSample.locked) nearestLock = Math.min(nearestLock, offsetDistance)
      neighbors.set(wrappedIndex, Math.min(offsetDistance, neighbors.get(wrappedIndex) ?? Infinity))
      if (neighborSample.locked) break
    }
  }
  const orderedNeighbors = [...neighbors].sort(
    ([firstIndex, firstDistance], [secondIndex, secondDistance]) => {
      const first = required(samples[firstIndex], 'Terrain curve neighborhood sample is missing.')
      const second = required(samples[secondIndex], 'Terrain curve neighborhood sample is missing.')
      return (
        firstDistance - secondDistance ||
        first.rawY - second.rawY ||
        first.rawX - second.rawX ||
        firstIndex - secondIndex
      )
    },
  )
  for (const [neighborIndex, offsetDistance] of orderedNeighbors) {
    const weight = Math.max(0, 1 - offsetDistance / radius)
    const neighbor = required(
      positions[neighborIndex],
      'Terrain curve neighborhood point is missing.',
    )
    weightedX += neighbor.x * weight
    weightedY += neighbor.y * weight
    weightTotal += weight
  }
  return { x: weightedX / weightTotal, y: weightedY / weightTotal, nearestLock }
}

function adjacentOffsetDistance(
  samples: readonly WorkingPoint[],
  fromIndex: number,
  toIndex: number,
  direction: -1 | 1,
  totalLength: number,
  closed: boolean,
): number {
  const from = required(samples[fromIndex], 'Terrain curve offset start is missing.').sourceOffset
  const to = required(samples[toIndex], 'Terrain curve offset end is missing.').sourceOffset
  if (direction === 1) {
    if (to > from) return to - from
    if (closed) return totalLength - from + to
  } else {
    if (to < from) return from - to
    if (closed) return from + totalLength - to
  }
  return Number.POSITIVE_INFINITY
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
    hashUnit(hash(seed, 'curve-noise', column + offsetX, row + offsetY)) * 2 - 1
  const blendX = fade(localX)
  const blendY = fade(localY)
  const north = valueAt(0, 0) + (valueAt(1, 0) - valueAt(0, 0)) * blendX
  const south = valueAt(0, 1) + (valueAt(1, 1) - valueAt(0, 1)) * blendX
  return north + (south - north) * blendY
}

function interpolateHash(value: number, minimum: number, maximum: number): number {
  return minimum + hashUnit(value) * (maximum - minimum)
}

function hash(...parts: readonly (string | number)[]): number {
  let value = 2166136261
  for (const part of parts) {
    for (const character of String(part)) {
      value ^= character.charCodeAt(0)
      value = Math.imul(value, 16777619)
    }
    value ^= 31
    value = Math.imul(value, 16777619)
  }
  value ^= value >>> 16
  value = Math.imul(value, 0x7feb352d)
  value ^= value >>> 15
  value = Math.imul(value, 0x846ca68b)
  value ^= value >>> 16
  return value >>> 0
}

function hashUnit(value: number): number {
  return value / 0xffffffff
}

function normalizeOffset(offset: number, totalLength: number): number {
  const normalized = offset % totalLength
  return normalized < 0 ? normalized + totalLength : normalized
}

function offsetKey(offset: number): string {
  return offset.toFixed(OFFSET_DIGITS)
}

function distance(
  first: Pick<TerrainCurveSourcePoint, 'x' | 'y'>,
  second: Pick<TerrainCurveSourcePoint, 'x' | 'y'>,
): number {
  return Math.hypot(second.x - first.x, second.y - first.y)
}

function required<Value>(value: Value | undefined, message: string): Value {
  if (value === undefined) throw new Error(message)
  return value
}
