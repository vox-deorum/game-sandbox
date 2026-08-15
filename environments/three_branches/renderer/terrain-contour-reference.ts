/**
 * Reference geometry for terrain contours. The raw boundary polylines trace unit cell edges, so a
 * boundary that really runs at a shallow angle arrives quantized into stair runs of whatever length
 * that angle implies. Shaping and validation measure deviation against this reference instead, a
 * heavily smoothed copy of the raw boundary held within a fixed drift of it: that recovers the line
 * the stairs quantize at every run length, where corner treatment alone only reshapes the corners.
 * Locked geometry keeps its raw shape, so chains still meet their junctions exactly.
 */

import { distance, stableHashParts } from '@renderers/base/math.js'

import { shapeTerrainCurve } from './terrain-curves.js'
import { EPSILON, required } from './terrain-helpers.js'
import type {
  ContourCoordinate,
  ContourReference,
  TerrainContourSpan,
  TerrainCurveProfile,
  TerrainCurveSourcePoint,
} from './types.js'

/** A closed raw-arc interval used for locks and shoreline treatment. */
export interface OffsetInterval {
  readonly startOffset: number
  readonly endOffset: number
}

/** The chain fields that reference construction and lookups read. */
export interface ReferenceSourceChain {
  readonly rawPoints: readonly ContourCoordinate[]
  readonly spans: readonly TerrainContourSpan[]
  readonly rawLength: number
  readonly closed: boolean
}

/** One reference segment with its reference-arc interval. */
export interface ReferenceSegment {
  readonly start: ContourCoordinate
  readonly end: ContourCoordinate
  readonly startOffset: number
  readonly endOffset: number
}

/**
 * How far the reference may leave the raw boundary. A quantized straight run sits at most half a
 * step from the line it approximates, so this never binds on a staircase; it bounds how much shape
 * a genuinely sharp feature, such as a one-cell inlet, may lose.
 */
export const MAX_REFERENCE_DRIFT_CELLS = 0.55

/** Spacing of the reference samples along the raw boundary, in cells. */
const REFERENCE_SPACING_CELLS = 1

/**
 * Half-width of the fitting window in samples, and how many times the fit runs. Repeating a
 * modest window reaches further than one wide window without the overshoot a wide quadratic
 * develops on a winding bank.
 */
const SMOOTH_RADIUS_SAMPLES = 5
const SMOOTH_ROUNDS = 4

/** Return the mutable reference slot of a working chain or fail loudly. */
export function referenceOf(chain: { readonly reference?: ContourReference }): ContourReference {
  return required(chain.reference, 'Terrain contour chain has no reference geometry.')
}

/**
 * Build the smoothed reference polyline for one chain. The curve engine resamples by raw arc
 * length and pins locked samples onto the raw boundary, so its own output offsets are the raw
 * offsets this reference reports.
 */
export function buildContourReference(
  chain: ReferenceSourceChain,
  junctionTangentCells: number,
  layoutHash: number,
): ContourReference {
  const { rawPoints, spans, rawLength, closed } = chain
  const fixed = spans
    .filter((span) => span.fixed)
    .map((span) => ({ startOffset: span.startOffset, endOffset: span.endOffset }))
    .sort((first, second) => first.startOffset - second.startOffset)
  const lockedAt = (offset: number): boolean =>
    offsetLocked(offset, fixed, rawLength, closed, junctionTangentCells)

  const sourceOffsets = new Map<string, number>()
  const addSource = (offset: number): void => {
    const normalized = normalizedOffset(offset, rawLength, closed)
    sourceOffsets.set(contourOffsetKey(normalized), normalized)
  }
  // Sample on the profile's own grid rather than at every raw vertex, so the engine's resampling
  // lands on these offsets exactly. Carrying the vertices instead would leave the smoothing kernel
  // working on unevenly spaced points and would strand near-duplicate samples beside them.
  const spacing = REFERENCE_SPACING_CELLS
  for (let step = 0; step * spacing < rawLength; step += 1) addSource(step * spacing)
  if (!closed) addSource(rawLength)
  for (const offset of contourLockOffsets(fixed, rawLength, closed, junctionTangentCells)) {
    addSource(offset)
  }
  const source: TerrainCurveSourcePoint[] = [...sourceOffsets.values()]
    .sort((first, second) => first - second)
    .map((offset) => ({
      ...rawPointAt(offset, rawPoints, spans, rawLength, closed),
      locked: lockedAt(offset),
    }))
  // Structures, map borders, and saddle diamonds are locked end to end, so smoothing them would
  // only pin every sample back onto the boundary they started from. Their reference is the raw
  // polyline itself, carrying its vertices alone rather than a sampling grid nothing can move.
  const sourceOffsetList = [...sourceOffsets.values()].sort((first, second) => first - second)
  if (source.every((point) => point.locked)) return rawReference(source, sourceOffsetList, closed)

  const smoothed = smoothSamples(source, closed)

  const points: ContourCoordinate[] = []
  const rawOffsets: number[] = []
  const offsets: number[] = []
  const locked: boolean[] = []
  let accumulated = 0
  for (const [index, point] of smoothed.entries()) {
    const rawOffset = required(sourceOffsetList[index], 'Terrain reference offset is missing.')
    const anchor = rawPointAt(rawOffset, rawPoints, spans, rawLength, closed)
    const isLocked = required(source[index], 'Terrain reference sample is missing.').locked
    // A locked sample stays pinned onto the raw boundary, so it has no drift to bound.
    const held = isLocked
      ? { x: anchor.x, y: anchor.y }
      : driftLimited(anchor, point, MAX_REFERENCE_DRIFT_CELLS)
    if (index > 0) {
      const step = distance(required(points[index - 1], 'Terrain reference point is missing.'), held)
      if (step <= EPSILON) throw new Error('Terrain contour reference contains duplicate vertices.')
      accumulated += step
    }
    points.push(held)
    rawOffsets.push(rawOffset)
    offsets.push(accumulated)
    locked.push(isLocked)
  }
  const first = required(points[0], 'Terrain contour reference is empty.')
  const length = closed
    ? accumulated + distance(required(points.at(-1), 'Terrain contour reference is empty.'), first)
    : accumulated
  return { points, rawOffsets, offsets, length, locked }
}

/**
 * Low-pass the samples by fitting a quadratic through a window around each one.
 *
 * Plain averaging is the wrong tool here, however many times it runs: it pulls every bend toward
 * its chord, so on a bank that curves it spends the whole drift allowance straightening the arc
 * rather than the stairs, and the drift clamp then scales back the stair correction along with
 * it. A quadratic fit reproduces a bend of that shape exactly and removes only what it cannot
 * follow, which is the quantization rhythm. One window is too short to see past a long stair run,
 * so the fit repeats: each round reaches further while still reproducing the bend underneath.
 */
function smoothSamples(
  samples: readonly TerrainCurveSourcePoint[],
  closed: boolean,
): ContourCoordinate[] {
  const count = samples.length
  const radius = Math.min(SMOOTH_RADIUS_SAMPLES, Math.floor((count - 1) / 2))
  if (radius < 2) return samples.map(({ x, y }) => ({ x, y }))
  let squares = 0
  let quads = 0
  for (let offset = -radius; offset <= radius; offset += 1) {
    squares += offset * offset
    quads += offset ** 4
  }
  const determinant = (radius * 2 + 1) * quads - squares * squares
  const weights = Array.from({ length: radius * 2 + 1 }, (_, index) => {
    const offset = index - radius
    return (quads - squares * offset * offset) / determinant
  })
  let positions = samples.map(({ x, y }) => ({ x, y }))
  for (let round = 0; round < SMOOTH_ROUNDS; round += 1) {
    const current = positions
    positions = current.map((point, index) => {
      if (required(samples[index], 'Terrain reference sample is missing.').locked) return point
      let x = 0
      let y = 0
      for (let offset = -radius; offset <= radius; offset += 1) {
        // An open chain reflects at its ends, which keeps the window centred instead of dragging
        // the last samples toward whichever neighbor happens to exist.
        const at = closed ? (index + offset + count) % count : reflectIndex(index + offset, count)
        const neighbor = required(current[at], 'Terrain reference neighbor is missing.')
        const weight = required(weights[offset + radius], 'Terrain reference weight is missing.')
        x += neighbor.x * weight
        y += neighbor.y * weight
      }
      return { x, y }
    })
  }
  return positions
}

function reflectIndex(index: number, count: number): number {
  if (index < 0) return Math.min(count - 1, -index)
  if (index >= count) return Math.max(0, count * 2 - 2 - index)
  return index
}

/** The reference of a fully locked chain: its own samples, which nothing may move. */
function rawReference(
  source: readonly TerrainCurveSourcePoint[],
  rawOffsets: readonly number[],
  closed: boolean,
): ContourReference {
  const points = source.map(({ x, y }) => ({ x, y }))
  return withReferencePoints(
    { points, rawOffsets, offsets: [], length: 0, locked: points.map(() => true) },
    points,
    closed,
  )
}


/** Rebuild a reference around moved points, keeping their raw offsets and lock flags. */
export function withReferencePoints(
  reference: ContourReference,
  points: readonly ContourCoordinate[],
  closed: boolean,
): ContourReference {
  const offsets: number[] = []
  let accumulated = 0
  for (const [index, point] of points.entries()) {
    if (index > 0) {
      const step = distance(required(points[index - 1], 'Terrain reference point is missing.'), point)
      if (step <= EPSILON) throw new Error('Terrain contour reference contains duplicate vertices.')
      accumulated += step
    }
    offsets.push(accumulated)
  }
  const first = required(points[0], 'Terrain contour reference is empty.')
  return {
    ...reference,
    points: points.map(({ x, y }) => ({ x, y })),
    offsets,
    length: closed
      ? accumulated + distance(required(points.at(-1), 'Terrain contour reference is empty.'), first)
      : accumulated,
  }
}

/** Hold one smoothed point within its drift bound of the raw position it was sampled from. */
function driftLimited(
  anchor: ContourCoordinate,
  point: ContourCoordinate,
  bound: number,
): ContourCoordinate {
  const drift = distance(anchor, point)
  if (drift <= bound) return { x: point.x, y: point.y }
  const scale = drift <= EPSILON ? 0 : bound / drift
  return {
    x: anchor.x + (point.x - anchor.x) * scale,
    y: anchor.y + (point.y - anchor.y) * scale,
  }
}

/** Number of reference segments, including the seam segment of a closed chain. */
export function referenceSegmentCount(reference: ContourReference, closed: boolean): number {
  return closed ? reference.points.length : reference.points.length - 1
}

/** One reference segment by index, the closed seam segment coming last. */
export function referenceSegmentAt(
  reference: ContourReference,
  closed: boolean,
  index: number,
): ReferenceSegment {
  const pointCount = reference.points.length
  const start = required(reference.points[index], 'Terrain contour reference segment is missing.')
  const end = required(
    reference.points[(index + 1) % pointCount],
    'Terrain contour reference segment is missing.',
  )
  const startOffset = required(
    reference.offsets[index],
    'Terrain contour reference offset is missing.',
  )
  const endOffset =
    index + 1 < pointCount
      ? required(reference.offsets[index + 1], 'Terrain contour reference offset is missing.')
      : reference.length
  return { start, end, startOffset, endOffset }
}

interface ReferenceInterval {
  readonly startIndex: number
  readonly amount: number
}

function referenceIntervalAt(
  reference: ContourReference,
  closed: boolean,
  referenceOffset: number,
): ReferenceInterval {
  const normalized = normalizedOffset(referenceOffset, reference.length, closed)
  const offsets = reference.offsets
  let lower = 0
  let upper = offsets.length - 1
  while (lower < upper) {
    const middle = Math.floor((lower + upper + 1) / 2)
    if (offsets[middle]! <= normalized + EPSILON) lower = middle
    else upper = middle - 1
  }
  const startOffset = offsets[lower]!
  const endOffset = lower + 1 < offsets.length ? offsets[lower + 1]! : reference.length
  const span = endOffset - startOffset
  const amount = span <= EPSILON ? 0 : Math.max(0, Math.min(1, (normalized - startOffset) / span))
  return { startIndex: lower, amount }
}

/**
 * Map one reference-arc offset back to the raw arc. The interval search snaps offsets within the
 * shared tolerance onto vertex offsets, so pinned lock vertices keep their exact raw offsets.
 */
export function rawOffsetAtReferenceOffset(
  reference: ContourReference,
  closed: boolean,
  rawLength: number,
  referenceOffset: number,
): number {
  const { startIndex, amount } = referenceIntervalAt(reference, closed, referenceOffset)
  const rawStart = reference.rawOffsets[startIndex]!
  const rawEnd =
    startIndex + 1 < reference.rawOffsets.length ? reference.rawOffsets[startIndex + 1]! : rawLength
  return rawStart + (rawEnd - rawStart) * amount
}

/** The reference position at one reference-arc offset. */
export function referencePointAtReferenceOffset(
  reference: ContourReference,
  closed: boolean,
  referenceOffset: number,
): ContourCoordinate {
  const { startIndex, amount } = referenceIntervalAt(reference, closed, referenceOffset)
  const start = reference.points[startIndex]!
  const end = reference.points[(startIndex + 1) % reference.points.length]!
  return { x: start.x + (end.x - start.x) * amount, y: start.y + (end.y - start.y) * amount }
}

/** The reference position at one raw-arc offset, interpolated through the raw-offset mapping. */
export function referencePointAtRawOffset(
  reference: ContourReference,
  closed: boolean,
  rawLength: number,
  rawOffset: number,
): ContourCoordinate {
  const normalized = normalizedOffset(rawOffset, rawLength, closed)
  const rawOffsets = reference.rawOffsets
  let lower = 0
  let upper = rawOffsets.length - 1
  while (lower < upper) {
    const middle = Math.floor((lower + upper + 1) / 2)
    if (rawOffsets[middle]! <= normalized + EPSILON) lower = middle
    else upper = middle - 1
  }
  const rawStart = rawOffsets[lower]!
  const rawEnd = lower + 1 < rawOffsets.length ? rawOffsets[lower + 1]! : rawLength
  const span = rawEnd - rawStart
  const amount = span <= EPSILON ? 0 : Math.max(0, Math.min(1, (normalized - rawStart) / span))
  const start = reference.points[lower]!
  const end = reference.points[(lower + 1) % reference.points.length]!
  return { x: start.x + (end.x - start.x) * amount, y: start.y + (end.y - start.y) * amount }
}

/** Normalize one arc offset into a closed chain's period or clamp it to an open chain. */
export function normalizedOffset(offset: number, length: number, closed: boolean): number {
  if (!closed) return Math.max(0, Math.min(length, offset))
  const normalized = offset % length
  return normalized < 0 ? normalized + length : normalized
}

/** The raw position at one raw-arc offset. */
export function rawPointAt(
  offset: number,
  rawPoints: readonly ContourCoordinate[],
  spans: readonly TerrainContourSpan[],
  rawLength: number,
  closed: boolean,
): ContourCoordinate {
  const normalized = normalizedOffset(offset, rawLength, closed)
  let lower = 0
  let upper = spans.length
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2)
    if (spans[middle]!.endOffset > normalized + EPSILON) upper = middle
    else lower = middle + 1
  }
  const selectedIndex = Math.min(lower, spans.length - 1)
  const selected = spans[selectedIndex]!
  const start = rawPoints[selectedIndex]!
  const end = rawPoints[selectedIndex + 1]!
  const amount = Math.max(
    0,
    Math.min(1, (normalized - selected.startOffset) / (selected.endOffset - selected.startOffset)),
  )
  return { x: start.x + (end.x - start.x) * amount, y: start.y + (end.y - start.y) * amount }
}

/** Whether one raw offset sits inside locked geometry. */
export function offsetLocked(
  offset: number,
  fixedIntervals: readonly OffsetInterval[],
  rawLength: number,
  closed: boolean,
  tangentLength: number,
): boolean {
  const normalized = normalizedOffset(offset, rawLength, closed)
  if (
    !closed &&
    (normalized <= tangentLength + EPSILON || rawLength - normalized <= tangentLength + EPSILON)
  ) {
    return true
  }
  return (
    nearestIntervalDistance(normalized, fixedIntervals, rawLength, closed) <=
    tangentLength + EPSILON
  )
}

/** Raw offsets that must appear as pinned curve vertices around locked geometry. */
export function contourLockOffsets(
  fixedIntervals: readonly OffsetInterval[],
  rawLength: number,
  closed: boolean,
  tangentLength: number,
): number[] {
  const offsets: number[] = []
  const offsetKeys = new Set<string>()
  const add = (offset: number): void => {
    const normalized = normalizedOffset(offset, rawLength, closed)
    const key = contourOffsetKey(normalized)
    if (offsetKeys.has(key)) return
    offsetKeys.add(key)
    offsets.push(normalized)
  }
  if (!closed) {
    add(0)
    add(Math.min(tangentLength, rawLength))
    add(Math.max(0, rawLength - tangentLength))
    add(rawLength)
  }
  for (const interval of fixedIntervals) {
    add(interval.startOffset - tangentLength)
    add(interval.startOffset)
    add(interval.endOffset)
    add(interval.endOffset + tangentLength)
  }
  return offsets.sort((first, second) => first - second)
}

/** Stable dedupe key for one arc offset. */
export function contourOffsetKey(offset: number): string {
  return offset.toFixed(9)
}

/** Arc distance from one offset to an interval, wrapping around closed chains. */
export function circularDistanceToInterval(
  offset: number,
  start: number,
  end: number,
  length: number,
  closed: boolean,
): number {
  const direct = offset < start ? start - offset : offset > end ? offset - end : 0
  if (!closed) return direct
  const below = Math.abs(offset + length - end)
  const above = Math.abs(start + length - offset)
  return Math.min(direct, below, above)
}

/** Arc distance from one offset to the nearest of the sorted intervals. */
export function nearestIntervalDistance(
  offset: number,
  intervals: readonly OffsetInterval[],
  length: number,
  closed: boolean,
): number {
  if (intervals.length === 0) return Number.POSITIVE_INFINITY
  let lower = 0
  let upper = intervals.length
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2)
    if (intervals[middle]!.startOffset <= offset) lower = middle + 1
    else upper = middle
  }
  const candidateIndexes = closed ? [lower - 1, lower, 0, intervals.length - 1] : [lower - 1, lower]
  let nearest = Number.POSITIVE_INFINITY
  for (const index of candidateIndexes) {
    if (index < 0 || index >= intervals.length) continue
    const interval = intervals[index]!
    nearest = Math.min(
      nearest,
      circularDistanceToInterval(offset, interval.startOffset, interval.endOffset, length, closed),
    )
  }
  return nearest
}
