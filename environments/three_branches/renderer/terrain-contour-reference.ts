/**
 * Reference geometry for terrain contours. The raw boundary polylines trace unit cell edges, so a
 * boundary that really runs at a shallow angle arrives quantized into stair runs of whatever length
 * that angle implies. Shaping and validation measure deviation against this reference instead: the
 * simplest polyline that stays within a fixed tolerance of the boundary's segment midpoints.
 *
 * Quantization error is bounded in amplitude, never in wavelength, so smoothing cannot remove it:
 * whatever window a filter uses, some map has stair runs longer than its reach, and they survive.
 * Tolerance simplification matches the error instead. The midpoints of the segments quantizing a
 * straight line are collinear on that line at every run length, so every staircase fits inside the
 * tolerance tube of one chord and collapses to it, while a genuine corner stays because it does
 * not fit. Locked geometry keeps its raw shape, so chains still meet their junctions exactly.
 */

import { distance } from '@renderers/base/math.js'

import { EPSILON, projectToSegment, required } from './terrain-helpers.js'
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
 * How far the reference may leave the raw boundary, and therefore the simplification tolerance.
 * The midpoints of a quantized straight run sit on the line it approximates, so this never binds
 * on a staircase; it bounds how much shape a genuinely sharp feature, such as a one-cell inlet,
 * may lose.
 */
export const MAX_REFERENCE_DRIFT_CELLS = 0.55

/** Spacing the simplified chords are resampled back to, in cells. */
const REFERENCE_SPACING_CELLS = 1

/**
 * A closed chain may not drift past its own mean inradius either, the enclosed area over the
 * perimeter. A small island is narrower than the drift bound in every direction, so that bound
 * alone would let its whole boundary slide inward and shrink it away. The mean inradius stays
 * below half the narrowest width of any loop, and grows past the drift bound as soon as a loop is
 * a few cells across, so a small feature keeps its shape while long staircase runs still flatten.
 */
function referenceDrift(
  rawPoints: readonly ContourCoordinate[],
  rawLength: number,
  closed: boolean,
): number {
  if (!closed || rawLength <= EPSILON) return MAX_REFERENCE_DRIFT_CELLS
  let twiceArea = 0
  for (let index = 0; index + 1 < rawPoints.length; index += 1) {
    const first = required(rawPoints[index], 'Terrain contour raw point is missing.')
    const second = required(rawPoints[index + 1], 'Terrain contour raw point is missing.')
    twiceArea += first.x * second.y - second.x * first.y
  }
  return Math.min(MAX_REFERENCE_DRIFT_CELLS, Math.abs(twiceArea) / 2 / rawLength)
}

/** Return the mutable reference slot of a working chain or fail loudly. */
export function referenceOf(chain: { readonly reference?: ContourReference }): ContourReference {
  return required(chain.reference, 'Terrain contour chain has no reference geometry.')
}

/** One candidate vertex of the simplified reference. */
interface ReferenceCandidate {
  readonly offset: number
  readonly point: ContourCoordinate
  readonly locked: boolean
  /** Whether this candidate is a run midpoint, sitting on the line its run quantizes. */
  readonly midline: boolean
}

/** One maximal collinear stretch of raw segments. */
interface SpanRun {
  readonly startOffset: number
  readonly endOffset: number
}

/**
 * Build the simplified reference polyline for one chain. The curve engine resamples by raw arc
 * length and pins locked samples onto the raw boundary, so its own output offsets are the raw
 * offsets this reference reports.
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
  const lockedAt = (offset: number): boolean =>
    offsetLocked(offset, fixed, rawLength, closed, junctionTangentCells)

  // Candidate vertices. Quantization noise lives entirely inside the straight runs of the raw
  // boundary, so a free run contributes only its midpoint, which sits on the line the run
  // quantizes; shape can only live at the corners between runs, so each run boundary joins as
  // well, and simplification drops the corners of a staircase, which stay within tolerance of the
  // run-midpoint chord, while keeping a genuine corner exactly. Locked stretches carry their raw
  // vertices and tangent points instead, since a lock must keep the raw shape.
  const offsetByKey = new Map<string, number>()
  const midlineKeys = new Set<string>()
  const addOffset = (offset: number, midline = false): void => {
    const normalized = normalizedOffset(offset, rawLength, closed)
    const key = contourOffsetKey(normalized)
    offsetByKey.set(key, normalized)
    if (midline) midlineKeys.add(key)
  }
  for (const span of spans) {
    if (lockedAt(span.startOffset)) addOffset(span.startOffset)
  }
  for (const run of collinearRuns(rawPoints, spans)) {
    addOffset(run.startOffset)
    const midpoint = (run.startOffset + run.endOffset) / 2
    if (!lockedAt(midpoint)) addOffset(midpoint, true)
  }
  if (!closed) addOffset(rawLength)
  for (const offset of contourLockOffsets(fixed, rawLength, closed, junctionTangentCells)) {
    addOffset(offset)
  }
  const candidates: ReferenceCandidate[] = [...offsetByKey.entries()]
    .sort(([, first], [, second]) => first - second)
    .map(([key, offset]) => ({
      offset,
      point: rawPointAt(offset, rawPoints, spans, rawLength, closed),
      locked: lockedAt(offset),
      midline: midlineKeys.has(key),
    }))
  const simplified = simplifyCandidates(
    candidates,
    closed,
    referenceDrift(rawPoints, rawLength, closed),
  )
  return assembleReference(simplified, rawLength, closed)
}

/**
 * Group the raw segments into maximal collinear runs. The seam of a closed chain always starts a
 * run: a collinear seam candidate sits on its neighbors' chord and simplifies away, so merging
 * across it would buy nothing.
 */
function collinearRuns(
  rawPoints: readonly ContourCoordinate[],
  spans: readonly TerrainContourSpan[],
): SpanRun[] {
  const runs: SpanRun[] = []
  const direction = (index: number): ContourCoordinate => {
    const from = required(rawPoints[index], 'Terrain contour raw point is missing.')
    const to = required(rawPoints[index + 1], 'Terrain contour raw point is missing.')
    return { x: to.x - from.x, y: to.y - from.y }
  }
  let start = 0
  for (let index = 1; index <= spans.length; index += 1) {
    if (index < spans.length) {
      const previous = direction(index - 1)
      const current = direction(index)
      const cross = previous.x * current.y - previous.y * current.x
      const dot = previous.x * current.x + previous.y * current.y
      if (Math.abs(cross) <= EPSILON && dot > 0) continue
    }
    runs.push({
      startOffset: required(spans[start], 'Terrain contour span is missing.').startOffset,
      endOffset: required(spans[index - 1], 'Terrain contour span is missing.').endOffset,
    })
    start = index
  }
  return runs
}

/**
 * Keep every locked candidate and, inside each free run between them, the minimal vertices whose
 * chords stay within the drift tolerance of the candidates they span.
 */
function simplifyCandidates(
  candidates: readonly ReferenceCandidate[],
  closed: boolean,
  drift: number,
): ReferenceCandidate[] {
  const count = candidates.length
  if (count < 3) return [...candidates]
  const kept = candidates.map((candidate) => candidate.locked)
  const anchors = candidates.flatMap((candidate, index) => (candidate.locked ? [index] : []))
  if (anchors.length === 0) {
    // A closed chain with nothing locked. Four spread anchors keep the loop a loop: with fewer, a
    // pond within tolerance of a line would collapse onto it. Midline candidates are preferred so
    // the anchors sit on the quantized line rather than hinging chords on a stair corner. Each
    // quarter takes a candidate no other quarter holds, since anchors that coincide leave the loop
    // spanned by fewer chords than it has sides and one whole side simplifies away.
    const midline = candidates.flatMap((candidate, index) => (candidate.midline ? [index] : []))
    const pool = midline.length >= 4 ? midline : candidates.map((_, index) => index)
    for (const quarter of [0, 1, 2, 3]) {
      const target = (quarter * count) / 4
      let best = -1
      for (const index of pool) {
        if (kept[index] === true) continue
        if (best < 0 || Math.abs(index - target) < Math.abs(best - target)) best = index
      }
      if (best < 0) break
      kept[best] = true
      anchors.push(best)
    }
    anchors.sort((first, second) => first - second)
  }
  const runs: [number, number][] = []
  for (let index = 0; index + 1 < anchors.length; index += 1) {
    runs.push([anchors[index]!, anchors[index + 1]!])
  }
  if (closed) runs.push([anchors[anchors.length - 1]!, anchors[0]! + count])
  else {
    // Open chains lock their end zones, so the ends are anchors already; guard the degenerate
    // configuration where they somehow are not.
    if (anchors[0]! > 0) runs.push([0, anchors[0]!])
    if (anchors[anchors.length - 1]! < count - 1) runs.push([anchors[anchors.length - 1]!, count - 1])
    kept[0] = true
    kept[count - 1] = true
  }
  const at = (index: number): ReferenceCandidate => candidates[index % count]!
  for (const run of runs) {
    const stack: [number, number][] = [run]
    while (stack.length > 0) {
      const [from, to] = stack.pop()!
      if (to - from < 2) continue
      let farthest = -1
      let largest = drift
      for (let index = from + 1; index < to; index += 1) {
        const foot = projectToSegment(at(index).point, at(from).point, at(to).point)
        const deviation = distance(at(index).point, foot)
        if (deviation > largest) {
          largest = deviation
          farthest = index
        }
      }
      if (farthest < 0) continue
      // The violation says where the chord must bend, and the bend goes to the nearest candidate
      // sitting on the quantized line, so a staircase corner never becomes a hinge that would
      // drag the chord off the line and push its neighbors over tolerance in turn. Only when the
      // window holds no midline candidate is the violation a genuine corner, kept exactly.
      let hinge = -1
      for (let index = from + 1; index < to; index += 1) {
        if (!at(index).midline) continue
        if (hinge < 0 || Math.abs(index - farthest) < Math.abs(hinge - farthest)) hinge = index
      }
      if (hinge < 0) hinge = farthest
      kept[hinge % count] = true
      stack.push([from, hinge], [hinge, to])
    }
  }
  return candidates.filter((_, index) => kept[index])
}

/**
 * Resample the simplified chords back to reference spacing and accumulate arc offsets. A closed
 * reference regains a vertex at raw offset zero, interpolated on its wrap chord, because the
 * raw-offset lookups treat the first vertex as the start of the raw period.
 */
function assembleReference(
  simplified: ReferenceCandidate[],
  rawLength: number,
  closed: boolean,
): ContourReference {
  const first = required(simplified[0], 'Terrain contour reference is empty.')
  if (closed && first.offset > EPSILON) {
    const last = required(simplified.at(-1), 'Terrain contour reference is empty.')
    const gap = rawLength - last.offset + first.offset
    const amount = gap <= EPSILON ? 0 : (rawLength - last.offset) / gap
    simplified.unshift({
      offset: 0,
      point: {
        x: last.point.x + (first.point.x - last.point.x) * amount,
        y: last.point.y + (first.point.y - last.point.y) * amount,
      },
      locked: false,
      midline: false,
    })
  }
  const points: ContourCoordinate[] = []
  const rawOffsets: number[] = []
  const locked: boolean[] = []
  for (const [index, vertex] of simplified.entries()) {
    points.push({ x: vertex.point.x, y: vertex.point.y })
    rawOffsets.push(vertex.offset)
    locked.push(vertex.locked)
    const next =
      index + 1 < simplified.length ? simplified[index + 1] : closed ? simplified[0] : undefined
    if (next === undefined) continue
    const nextOffset = index + 1 < simplified.length ? next.offset : rawLength
    const pieces = Math.ceil(distance(vertex.point, next.point) / REFERENCE_SPACING_CELLS)
    for (let piece = 1; piece < pieces; piece += 1) {
      const amount = piece / pieces
      points.push({
        x: vertex.point.x + (next.point.x - vertex.point.x) * amount,
        y: vertex.point.y + (next.point.y - vertex.point.y) * amount,
      })
      rawOffsets.push(vertex.offset + (nextOffset - vertex.offset) * amount)
      locked.push(false)
    }
  }
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
  const start = required(points[0], 'Terrain contour reference is empty.')
  const length = closed
    ? accumulated + distance(required(points.at(-1), 'Terrain contour reference is empty.'), start)
    : accumulated
  return { points, rawOffsets, offsets, length, locked }
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

/** One reference segment index paired with how far along it a lookup landed. */
export interface ReferenceInterval {
  readonly startIndex: number
  readonly amount: number
}

/** Locate one reference-arc offset on the reference polyline. */
export function referenceIntervalAt(
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

/**
 * Arc distance from one raw offset to the nearest locked geometry: a fixed span, or either end of
 * an open chain, which is pinned onto the junction the chain meets there.
 */
function lockedArcDistance(
  offset: number,
  fixedIntervals: readonly OffsetInterval[],
  rawLength: number,
  closed: boolean,
): number {
  const normalized = normalizedOffset(offset, rawLength, closed)
  const toFixed = nearestIntervalDistance(normalized, fixedIntervals, rawLength, closed)
  return closed ? toFixed : Math.min(toFixed, normalized, rawLength - normalized)
}

/** Whether one raw offset sits inside locked geometry. */
export function offsetLocked(
  offset: number,
  fixedIntervals: readonly OffsetInterval[],
  rawLength: number,
  closed: boolean,
  tangentLength: number,
): boolean {
  return lockedArcDistance(offset, fixedIntervals, rawLength, closed) <= tangentLength + EPSILON
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
