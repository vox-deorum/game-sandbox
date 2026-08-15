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

/**
 * Coarse samples and a wide smoothing radius, since the reference only has to carry run-scale
 * shape: the radius is `spacing * sqrt(passes / 2)`, so 2.5 cells here, which flattens stair runs
 * well past the longest a shallow bank produces. The reference stays a plain low-pass of the raw
 * boundary; the organic waver belongs to the shaping octaves, which ride on top of it.
 */
const REFERENCE_PROFILE: TerrainCurveProfile = {
  sampleSpacingCells: 0.5,
  smoothingPasses: 50,
  octaves: [],
}

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
  driftLimit: (point: ContourCoordinate, rawOffset: number) => number,
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
  const spacing = REFERENCE_PROFILE.sampleSpacingCells
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
  if (source.every((point) => point.locked)) return rawReference(chain)

  const smoothed = shapeTerrainCurve(
    source,
    closed,
    REFERENCE_PROFILE,
    stableHashParts('terrain-contour-reference', layoutHash),
    (rawX, rawY, sourceOffset) => driftLimit({ x: rawX, y: rawY }, sourceOffset),
  )

  const points: ContourCoordinate[] = []
  const rawOffsets: number[] = []
  const offsets: number[] = []
  const locked: boolean[] = []
  let accumulated = 0
  for (const [index, point] of smoothed.entries()) {
    const anchor = rawPointAt(point.sourceOffset, rawPoints, spans, rawLength, closed)
    // A locked sample is already pinned onto the raw boundary, so it has no drift to bound.
    const held = point.locked
      ? { x: anchor.x, y: anchor.y }
      : driftLimited(anchor, point, driftLimit(anchor, point.sourceOffset))
    if (index > 0) {
      const step = distance(required(points[index - 1], 'Terrain reference point is missing.'), held)
      if (step <= EPSILON) throw new Error('Terrain contour reference contains duplicate vertices.')
      accumulated += step
    }
    points.push(held)
    rawOffsets.push(point.sourceOffset)
    offsets.push(accumulated)
    locked.push(point.locked)
  }
  const first = required(points[0], 'Terrain contour reference is empty.')
  const length = closed
    ? accumulated + distance(required(points.at(-1), 'Terrain contour reference is empty.'), first)
    : accumulated
  return { points, rawOffsets, offsets, length, locked }
}

/** The reference of a fully locked chain: its own raw polyline, vertex for vertex. */
function rawReference(chain: ReferenceSourceChain): ContourReference {
  const { rawPoints, spans, rawLength, closed } = chain
  // A closed chain repeats its first raw point at the end, where the reference closes implicitly.
  const points = (closed ? rawPoints.slice(0, -1) : rawPoints).map(({ x, y }) => ({ x, y }))
  const rawOffsets = spans.map((span) => span.startOffset)
  if (!closed) rawOffsets.push(rawLength)
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

/** The unit heading of the raw boundary at one raw offset. */
export function rawHeadingAt(chain: ReferenceSourceChain, offset: number): ContourCoordinate {
  const normalized = normalizedOffset(offset, chain.rawLength, chain.closed)
  let lower = 0
  let upper = chain.spans.length
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2)
    if (chain.spans[middle]!.endOffset > normalized + EPSILON) upper = middle
    else lower = middle + 1
  }
  const index = Math.min(lower, chain.spans.length - 1)
  const start = required(chain.rawPoints[index], 'Terrain heading segment is missing.')
  const end = required(chain.rawPoints[index + 1], 'Terrain heading segment is missing.')
  const length = distance(start, end)
  if (length <= EPSILON) return { x: 0, y: 0 }
  return { x: (end.x - start.x) / length, y: (end.y - start.y) / length }
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
