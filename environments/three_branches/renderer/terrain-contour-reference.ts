/**
 * Corner-cut reference geometry for terrain contours. The raw boundary polylines trace unit cell
 * edges, so every free corner is a right angle on the integer grid. Shaping and validation measure
 * deviation against this reference instead of that staircase: each free corner is replaced by a
 * chord cut at a deterministically jittered fraction of its incident edges, which turns one-cell
 * stairs into clean diagonals before any smoothing runs. Locked geometry keeps its raw shape, so
 * chains still meet their junctions exactly.
 */

import { distance, hashUnit, stableHashParts } from '@renderers/base/math.js'

import { EPSILON, required } from './terrain-helpers.js'
import type { ContourCoordinate, ContourReference, TerrainContourSpan } from './types.js'

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
 * Corner cuts land between these fractions of each incident edge. The spread supplies the
 * deterministic non-uniformity that octave noise cannot add inside tight corridors, and the upper
 * bound keeps the two cuts that share one edge strictly apart.
 */
const CORNER_CUT_MIN_FRACTION = 0.32
const CORNER_CUT_MAX_FRACTION = 0.48

/** Margin that keeps cut chords strictly clear of locked geometry and its lock vertices. */
const CUT_PROTECTION_MARGIN = 1e-6

interface ReferenceVertex {
  readonly x: number
  readonly y: number
  readonly rawOffset: number
}

/** Return the mutable reference slot of a working chain or fail loudly. */
export function referenceOf(chain: { readonly reference?: ContourReference }): ContourReference {
  return required(chain.reference, 'Terrain contour chain has no reference geometry.')
}

/** Build the corner-cut reference polyline for one chain. */
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
  const protectedIntervals: OffsetInterval[] = fixed.map((interval) => ({
    startOffset: interval.startOffset - junctionTangentCells - CUT_PROTECTION_MARGIN,
    endOffset: interval.endOffset + junctionTangentCells + CUT_PROTECTION_MARGIN,
  }))
  if (!closed) {
    protectedIntervals.push(
      { startOffset: -1, endOffset: junctionTangentCells + CUT_PROTECTION_MARGIN },
      { startOffset: rawLength - junctionTangentCells - CUT_PROTECTION_MARGIN, endOffset: rawLength + 1 },
    )
  }

  const vertexCount = closed ? spans.length : rawPoints.length
  const vertices: ReferenceVertex[] = []
  for (let index = 0; index < vertexCount; index += 1) {
    const vertex = required(rawPoints[index], 'Terrain contour reference vertex is missing.')
    const offset = index < spans.length ? spans[index]!.startOffset : rawLength
    if (!closed && (index === 0 || index === vertexCount - 1)) {
      vertices.push({ x: vertex.x, y: vertex.y, rawOffset: offset })
      continue
    }
    const beforeIndex = index === 0 ? vertexCount - 1 : index - 1
    const before = required(rawPoints[beforeIndex], 'Terrain contour reference vertex is missing.')
    const after = required(rawPoints[index + 1], 'Terrain contour reference vertex is missing.')
    const lengthBefore =
      index === 0 ? rawLength - spans[vertexCount - 1]!.startOffset : offset - spans[index - 1]!.startOffset
    const lengthAfter = (index < spans.length ? spans[index]!.endOffset : rawLength) - offset
    const cross =
      ((vertex.x - before.x) * (after.y - vertex.y) - (vertex.y - before.y) * (after.x - vertex.x)) /
      (lengthBefore * lengthAfter)
    if (Math.abs(cross) <= EPSILON) {
      vertices.push({ x: vertex.x, y: vertex.y, rawOffset: offset })
      continue
    }
    const fraction =
      CORNER_CUT_MIN_FRACTION +
      hashUnit(stableHashParts('terrain-contour-corner-cut', layoutHash, vertex.x, vertex.y)) *
        (CORNER_CUT_MAX_FRACTION - CORNER_CUT_MIN_FRACTION)
    const cutStart = offset - fraction * lengthBefore
    const cutEnd = offset + fraction * lengthAfter
    if (overlapsProtected(cutStart, cutEnd, protectedIntervals, rawLength, closed)) {
      vertices.push({ x: vertex.x, y: vertex.y, rawOffset: offset })
      continue
    }
    const cutBefore = {
      x: vertex.x + (before.x - vertex.x) * fraction,
      y: vertex.y + (before.y - vertex.y) * fraction,
    }
    const cutAfter = {
      x: vertex.x + (after.x - vertex.x) * fraction,
      y: vertex.y + (after.y - vertex.y) * fraction,
    }
    if (closed && index === 0) {
      // The chord across the seam corner spans raw offset zero. Emit the prorated zero point so
      // raw offsets stay monotone from zero, which downstream seam interpolation relies on.
      const amount = lengthBefore / (lengthBefore + lengthAfter)
      vertices.push({
        x: cutBefore.x + (cutAfter.x - cutBefore.x) * amount,
        y: cutBefore.y + (cutAfter.y - cutBefore.y) * amount,
        rawOffset: 0,
      })
      vertices.push({ ...cutAfter, rawOffset: cutEnd })
      vertices.push({ ...cutBefore, rawOffset: rawLength + cutStart })
      continue
    }
    vertices.push({ ...cutBefore, rawOffset: cutStart }, { ...cutAfter, rawOffset: cutEnd })
  }

  const present = new Set(vertices.map((vertex) => contourOffsetKey(vertex.rawOffset)))
  for (const offset of contourLockOffsets(fixed, rawLength, closed, junctionTangentCells)) {
    const key = contourOffsetKey(offset)
    if (present.has(key)) continue
    present.add(key)
    vertices.push({ ...rawPointAt(offset, rawPoints, spans, rawLength, closed), rawOffset: offset })
  }
  vertices.sort((first, second) => first.rawOffset - second.rawOffset)

  const points: ContourCoordinate[] = []
  const rawOffsets: number[] = []
  const offsets: number[] = []
  let accumulated = 0
  for (const [index, vertex] of vertices.entries()) {
    if (index > 0) {
      const step = distance(vertices[index - 1]!, vertex)
      if (step <= EPSILON) throw new Error('Terrain contour reference contains duplicate vertices.')
      accumulated += step
    }
    points.push({ x: vertex.x, y: vertex.y })
    rawOffsets.push(vertex.rawOffset)
    offsets.push(accumulated)
  }
  const length = closed
    ? accumulated + distance(required(vertices.at(-1), 'Terrain contour reference is empty.'), vertices[0]!)
    : accumulated
  return {
    points,
    rawOffsets,
    offsets,
    length,
    locked: rawOffsets.map((offset) =>
      offsetLocked(offset, fixed, rawLength, closed, junctionTangentCells),
    ),
  }
}

function overlapsProtected(
  start: number,
  end: number,
  intervals: readonly OffsetInterval[],
  rawLength: number,
  closed: boolean,
): boolean {
  const overlaps = (shift: number): boolean =>
    intervals.some(
      (interval) => start + shift <= interval.endOffset && interval.startOffset <= end + shift,
    )
  if (overlaps(0)) return true
  return closed && (overlaps(rawLength) || overlaps(-rawLength))
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
