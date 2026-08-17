/**
 * Reference geometry for terrain contours: the raw boundary itself, carrying a vertex at every raw
 * corner and at every lock boundary. Shaping and validation measure deviation against it. Every
 * vertex sits on the raw polyline with no raw corner skipped, so a reference chord is exactly its
 * raw arc and one offset scale, the raw one, serves the whole pipeline.
 */

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

/** Return the mutable reference slot of a working chain or fail loudly. */
export function referenceOf(chain: { readonly reference?: ContourReference }): ContourReference {
  return required(chain.reference, 'Terrain contour chain has no reference geometry.')
}

/**
 * Build the reference polyline for one chain: a vertex at every raw corner, plus the lock
 * boundaries the curve engine has to pin samples onto. The engine resamples by raw arc length, so
 * its output offsets are the raw offsets this reference reports.
 */
export function buildContourReference(
  chain: ReferenceSourceChain,
  junctionTangentCells: number,
): ContourReference {
  const { rawPoints, spans, rawLength, closed } = chain
  const fixed = spans
    .filter((span) => span.fixed)
    .map((span) => ({ startOffset: span.startOffset, endOffset: span.endOffset }))
    .sort((first, second) => first.startOffset - second.startOffset)
  const offsetByKey = new Map<string, number>()
  const addOffset = (offset: number): void => {
    const normalized = normalizedOffset(offset, rawLength, closed)
    offsetByKey.set(contourOffsetKey(normalized), normalized)
  }
  for (const span of spans) addOffset(span.startOffset)
  if (!closed) addOffset(rawLength)
  for (const offset of contourLockOffsets(fixed, rawLength, closed, junctionTangentCells)) {
    addOffset(offset)
  }
  const offsets = [...offsetByKey.values()].sort((first, second) => first - second)
  return {
    points: offsets.map((offset) => rawPointAt(offset, rawPoints, spans, rawLength, closed)),
    offsets,
    locked: offsets.map((offset) =>
      offsetLocked(offset, fixed, rawLength, closed, junctionTangentCells),
    ),
  }
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

/**
 * Whether one raw offset sits inside locked geometry, meaning within a tangent length of a fixed
 * span, or of either end of an open chain, which is pinned onto the junction it meets there.
 */
export function offsetLocked(
  offset: number,
  fixedIntervals: readonly OffsetInterval[],
  rawLength: number,
  closed: boolean,
  tangentLength: number,
): boolean {
  const normalized = normalizedOffset(offset, rawLength, closed)
  const toFixed = nearestIntervalDistance(normalized, fixedIntervals, rawLength, closed)
  const arcDistance = closed ? toFixed : Math.min(toFixed, normalized, rawLength - normalized)
  return arcDistance <= tangentLength + EPSILON
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
function circularDistanceToInterval(
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
