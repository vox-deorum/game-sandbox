/**
 * Reference geometry for terrain contours. The raw boundary polylines trace unit cell edges, so a
 * boundary that really runs at an angle arrives quantized into stair runs of whatever length that
 * angle implies. Shaping and validation measure deviation against this reference instead.
 *
 * Whether a corner between two straight runs is quantization or shape is a question about the way
 * the boundary continues, not about any distance: a boundary that steps and carries on the same
 * way is drawing a line the grid cannot draw, while a boundary that turns back is drawing a
 * feature. So a corner is dropped when its two neighbouring runs travel in the same direction,
 * which makes it one step of a staircase, and kept exactly otherwise, which covers every corner of
 * a rectangle, every tip, and every notch. A dropped corner leaves the midpoints of the runs it
 * joined, and those midpoints sit on the line their runs quantize, at every run length and however
 * the slope varies along the boundary. Reading them as a polyline therefore recovers the line the
 * staircase was drawing without flattening it into a ruled one. Locked geometry keeps its raw
 * shape, so chains still meet their junctions exactly.
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
 * How far the reference may leave the candidates it spans, and therefore how much of the residual
 * wobble between run midpoints it may flatten. Midpoints are collinear wherever the runs they
 * belong to keep the same lengths, so this only has to absorb the wobble left where run lengths
 * change, which is a fraction of a cell. It also bounds how much shape a genuinely sharp feature,
 * such as a one-cell inlet, may lose.
 */
export const MAX_REFERENCE_DRIFT_CELLS = 0.55

/** Spacing the reference chords are resampled back to, in cells. */
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

/** One vertex of the reference polyline. */
interface ReferenceVertex {
  readonly offset: number
  readonly point: ContourCoordinate
  readonly locked: boolean
  /** Whether this vertex is a run midpoint, where the line that run quantizes passes. */
  readonly midline: boolean
}

/** One maximal straight stretch of the raw boundary, with the direction it travels. */
interface SpanRun {
  readonly startOffset: number
  readonly endOffset: number
  readonly direction: ContourCoordinate
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

  // Candidate vertices. A step corner is never one: it is the grid drawing an angle, so offering
  // it would let the reference hinge on the staircase itself. Every other corner is offered
  // exactly, and every run offers its midpoint, which is where the line the run quantizes passes.
  // Locked stretches carry their raw vertices and tangent points instead, since a lock keeps the
  // raw shape whatever the geometry around it is doing.
  const runs = straightRuns(rawPoints, spans, rawLength, closed)
  const step = stepCorners(runs, closed)
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
  for (const [index, run] of runs.entries()) {
    if (step[index] !== true) addOffset(run.startOffset)
    const midpoint = (run.startOffset + run.endOffset) / 2
    if (!lockedAt(midpoint)) addOffset(midpoint, true)
  }
  if (!closed) addOffset(rawLength)
  for (const offset of contourLockOffsets(fixed, rawLength, closed, junctionTangentCells)) {
    addOffset(offset)
  }
  const candidates: ReferenceVertex[] = [...offsetByKey.entries()]
    .sort(([, first], [, second]) => first - second)
    .map(([key, offset]) => ({
      offset,
      point: rawPointAt(offset, rawPoints, spans, rawLength, closed),
      locked: lockedAt(offset),
      midline: midlineKeys.has(key),
    }))
  return assembleReference(
    simplifyCandidates(candidates, closed, referenceDrift(rawPoints, rawLength, closed)),
    rawLength,
    closed,
  )
}

/**
 * Which corners are steps of a staircase rather than shape.
 *
 * `step[index]` covers the corner where run `index` begins. A run whose two neighbours travel the
 * same way has crossed between them, which is the boundary travelling, stepping over, and carrying
 * on. One crossing on its own settles nothing, since a one-cell notch opens exactly that way and
 * only turns back on its far side. Two neighbouring crossings do settle it: the boundary has
 * stepped over twice the same way, which is how the grid draws a line at an angle, at any run
 * length and at any slope. So a corner is a step when it sits inside four runs alternating between
 * the same two directions, and stays exactly where the raw boundary put it otherwise, which covers
 * every corner of a rectangle and every tip, notch, and lone step along an edge.
 */
function stepCorners(runs: readonly SpanRun[], closed: boolean): boolean[] {
  const count = runs.length
  const step = runs.map(() => false)
  if (count < 4) return step
  const crossings = runs.map((_, index) => {
    if (!closed && (index < 1 || index + 1 >= count)) return false
    const before = required(runs[(index - 1 + count) % count], 'Terrain contour run is missing.')
    const after = required(runs[(index + 1) % count], 'Terrain contour run is missing.')
    return (
      Math.abs(before.direction.x - after.direction.x) <= EPSILON &&
      Math.abs(before.direction.y - after.direction.y) <= EPSILON
    )
  })
  const crosses = (index: number): boolean =>
    !closed && (index < 0 || index >= count)
      ? false
      : crossings[(index + count) % count] === true
  for (let index = 0; index < count; index += 1) {
    // Two neighbouring crossings reaching across this corner put it inside the four-run stretch.
    step[index] =
      (crosses(index - 2) && crosses(index - 1)) ||
      (crosses(index - 1) && crosses(index)) ||
      (crosses(index) && crosses(index + 1))
  }
  return step
}

/**
 * Group the raw segments into maximal straight runs, each carrying the unit direction it travels.
 * A closed chain merges its seam run into the first one when the two continue each other, since
 * the seam is an arbitrary point on a loop and a run split there would read as a corner.
 */
function straightRuns(
  rawPoints: readonly ContourCoordinate[],
  spans: readonly TerrainContourSpan[],
  rawLength: number,
  closed: boolean,
): SpanRun[] {
  const runs: SpanRun[] = []
  const direction = (index: number): ContourCoordinate => {
    const from = required(rawPoints[index], 'Terrain contour raw point is missing.')
    const to = required(rawPoints[index + 1], 'Terrain contour raw point is missing.')
    const length = Math.hypot(to.x - from.x, to.y - from.y)
    return { x: (to.x - from.x) / length, y: (to.y - from.y) / length }
  }
  const continues = (first: ContourCoordinate, second: ContourCoordinate): boolean =>
    Math.abs(first.x - second.x) <= EPSILON && Math.abs(first.y - second.y) <= EPSILON
  let start = 0
  for (let index = 1; index <= spans.length; index += 1) {
    if (index < spans.length && continues(direction(index - 1), direction(index))) continue
    runs.push({
      startOffset: required(spans[start], 'Terrain contour span is missing.').startOffset,
      endOffset: required(spans[index - 1], 'Terrain contour span is missing.').endOffset,
      direction: direction(start),
    })
    start = index
  }
  const first = runs[0]
  const last = runs.at(-1)
  if (closed && runs.length > 2 && first !== undefined && last !== undefined) {
    if (continues(first.direction, last.direction)) {
      runs[0] = { ...first, startOffset: last.startOffset - rawLength }
      runs.pop()
    }
  }
  return runs
}

/**
 * Keep every locked candidate and, between them, the fewest vertices whose chords stay within the
 * drift bound of the candidates they span. What survives here is the wobble left after the step
 * corners were withheld: a stretch of staircase offers only its run midpoints, and those sit on
 * one line for as long as the runs keep their lengths, so one chord spans the lot.
 */
function simplifyCandidates(
  candidates: readonly ReferenceVertex[],
  closed: boolean,
  drift: number,
): ReferenceVertex[] {
  const count = candidates.length
  if (count < 3) return [...candidates]
  const kept = candidates.map((candidate) => candidate.locked)
  const anchors = candidates.flatMap((candidate, index) => (candidate.locked ? [index] : []))
  if (anchors.length === 0) {
    // A closed chain with nothing locked. Four spread anchors keep the loop a loop: with fewer, a
    // pond within tolerance of a line would collapse onto it. Midline vertices are preferred so
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
  const at = (index: number): ReferenceVertex => candidates[index % count]!
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
      // The violation says where the chord must bend, and the bend goes to the nearest vertex
      // sitting on the quantized line, so a corner the raw boundary happens to pass through never
      // becomes a hinge that would drag the chord off that line and push its neighbours over the
      // bound in turn. Only when the window holds no midline vertex is the violation a genuine
      // corner, kept exactly.
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
 * Resample the reference chords back to reference spacing and accumulate arc offsets. A closed
 * reference regains a vertex at raw offset zero, interpolated on its wrap chord, because the
 * raw-offset lookups treat the first vertex as the start of the raw period.
 */
function assembleReference(
  simplified: ReferenceVertex[],
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
    if (index > 0) accumulated += distance(points[index - 1]!, point)
    offsets.push(accumulated)
  }
  const start = required(points[0], 'Terrain contour reference is empty.')
  const length = closed
    ? accumulated + distance(required(points.at(-1), 'Terrain contour reference is empty.'), start)
    : accumulated
  return { points, rawOffsets, offsets, length, locked }
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
