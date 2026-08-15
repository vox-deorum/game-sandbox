import { distance, stableHashParts } from '@renderers/base/math.js'

import { TERRAIN_EXTERIOR } from './terrain-contour-grid.js'
import { cellKey, EPSILON, pointToSegmentDistance, projectToSegment } from './terrain-helpers.js'
import { shapeTerrainCurve } from './terrain-curves.js'
import type {
  ContourCoordinate,
  TerrainContourPoint,
  TerrainContourSettings,
  TerrainContourSpan,
  TerrainCurveEnvelope,
  TerrainCurveSourcePoint,
} from './types.js'
import type { WorkingChain } from './terrain-contour-graph.js'
/** A closed raw-arc interval used for locks and shoreline treatment. */
export interface OffsetInterval {
  readonly startOffset: number
  readonly endOffset: number
}

interface ContourSpanIndex {
  readonly spans: readonly TerrainContourSpan[]
  readonly fixed: readonly OffsetInterval[]
  readonly bridgeSuppressed: readonly OffsetInterval[]
  readonly hasShoreline: boolean
}

/** One raw source segment tagged with its owning chain and arc interval for clearance queries. */
interface ClearanceSegment {
  readonly chain: WorkingChain
  readonly start: ContourCoordinate
  readonly end: ContourCoordinate
  readonly startOffset: number
  readonly endOffset: number
}

/** Cell-bucketed raw segments of every chain, queried while each single chain is shaped. */
type ClearanceIndex = ReadonlyMap<string, readonly ClearanceSegment[]>

/** Clearance beyond this many cells never tightens the envelope, so the query stays local. */
const CLEARANCE_SEARCH_CELLS = 3

/** Arc reach when clamping a shaped point against its own local stretch of raw boundary. */
const CLAMP_WINDOW_CELLS = 2.5

/**
 * A same-chain segment competes for clearance only when its arc distance is clearly larger than
 * its straight-line distance. Local continuation stays excluded so it can smooth: a straight run
 * holds ratio one and a diagonal staircase about 1.4. Facing walls of an inlet or hairpin sit at
 * two and above and must count, or the two sides smooth across their corridor into each other.
 */
const SELF_FOLD_ARC_RATIO = 1.6

export function buildClearanceIndex(chains: readonly WorkingChain[]): ClearanceIndex {
  const buckets = new Map<string, ClearanceSegment[]>()
  for (const chain of chains) {
    for (const [index, span] of chain.spans.entries()) {
      const start = chain.rawPoints[index]
      const end = chain.rawPoints[index + 1]
      if (start === undefined || end === undefined) {
        throw new Error('Terrain contour clearance segment is missing its raw points.')
      }
      const segment: ClearanceSegment = {
        chain,
        start,
        end,
        startOffset: span.startOffset,
        endOffset: span.endOffset,
      }
      const minimumX = Math.floor(Math.min(start.x, end.x))
      const maximumX = Math.floor(Math.max(start.x, end.x))
      const minimumY = Math.floor(Math.min(start.y, end.y))
      const maximumY = Math.floor(Math.max(start.y, end.y))
      for (let y = minimumY; y <= maximumY; y += 1) {
        for (let x = minimumX; x <= maximumX; x += 1) {
          const key = cellKey(x, y)
          const bucket = buckets.get(key) ?? []
          bucket.push(segment)
          buckets.set(key, bucket)
        }
      }
    }
  }
  return buckets
}

/**
 * Distance from one raw sample to the nearest competing raw segment. Segments of the same chain
 * count only beyond a short arc window, so a serpentine chain cannot pinch its own corridor.
 */
function clearanceAt(
  index: ClearanceIndex,
  chain: WorkingChain,
  point: ContourCoordinate,
  sourceOffset: number,
  arcWindowCells: number,
): number {
  const column = Math.floor(point.x)
  const row = Math.floor(point.y)
  let nearest = Number.POSITIVE_INFINITY
  for (let y = row - CLEARANCE_SEARCH_CELLS; y <= row + CLEARANCE_SEARCH_CELLS; y += 1) {
    for (let x = column - CLEARANCE_SEARCH_CELLS; x <= column + CLEARANCE_SEARCH_CELLS; x += 1) {
      for (const segment of index.get(cellKey(x, y)) ?? []) {
        const separation = pointToSegmentDistance(point, segment.start, segment.end)
        if (segment.chain === chain) {
          const arcDistance = circularDistanceToInterval(
            normalizedOffset(sourceOffset, chain.rawLength, chain.closed),
            segment.startOffset,
            segment.endOffset,
            chain.rawLength,
            chain.closed,
          )
          const window = Math.max(arcWindowCells, SELF_FOLD_ARC_RATIO * separation)
          if (arcDistance <= window + EPSILON) continue
        }
        nearest = Math.min(nearest, separation)
      }
    }
  }
  return nearest
}

/**
 * Shape one chain. Junction tangents and fixed spans stay locked, octave noise fades under the
 * clearance envelope, and every free point is finally clamped to that envelope so smoothing can
 * never leave the tube either.
 */
function shapeContourChain(
  chain: WorkingChain,
  settings: TerrainContourSettings,
  bridgeTaperCells: number,
  layoutHash: number,
  clearanceIndex: ClearanceIndex,
): readonly TerrainContourPoint[] {
  const spanIndex = indexContourSpans(chain.spans)
  const lockOffsets = contourLockOffsets(
    spanIndex.fixed,
    chain.rawLength,
    chain.closed,
    settings.junctionTangentCells,
  )
  const profile = chain.pairKey.split('\u0000').includes('water')
    ? settings.profiles.water
    : settings.profiles.land
  const source = curveSourcePoints(
    chain.rawPoints,
    chain.spans,
    chain.rawLength,
    chain.closed,
    lockOffsets,
    spanIndex,
    settings.junctionTangentCells,
  )
  const envelope: TerrainCurveEnvelope = (rawX, rawY, sourceOffset) => {
    const clearance = clearanceAt(
      clearanceIndex,
      chain,
      { x: rawX, y: rawY },
      sourceOffset,
      settings.minimumCorridorCells * 2,
    )
    return Math.max(
      0,
      Math.min(settings.maxDeviationCells, (clearance - settings.minimumCorridorCells) / 2),
    )
  }
  const shaped = shapeTerrainCurve(
    source,
    chain.closed,
    profile,
    stableHashParts('terrain-contour-shape', layoutHash, chain.pairKey),
    envelope,
  )
  return shaped.map((point): TerrainContourPoint => {
    const raw = rawPointAt(
      point.sourceOffset,
      chain.rawPoints,
      spanIndex.spans,
      chain.rawLength,
      chain.closed,
    )
    const rawOffset = normalizedOffset(point.sourceOffset, chain.rawLength, chain.closed)
    const shorelineFactor = shorelineFactorAt(
      point.sourceOffset,
      spanIndex,
      chain.rawLength,
      chain.closed,
      bridgeTaperCells,
    )
    const locked = offsetLocked(
      point.sourceOffset,
      spanIndex.fixed,
      chain.rawLength,
      chain.closed,
      settings.junctionTangentCells,
    )
    if (locked) return { x: raw.x, y: raw.y, rawOffset, locked: true, shorelineFactor }
    const nearest = nearestOwnSegment(chain, point, rawOffset)
    const cap = Math.min(
      envelope(raw.x, raw.y, point.sourceOffset),
      envelope(nearest.foot.x, nearest.foot.y, nearest.footOffset),
    )
    if (nearest.separation <= cap) {
      return { x: point.x, y: point.y, rawOffset, locked: false, shorelineFactor }
    }
    const scale = nearest.separation <= EPSILON ? 0 : cap / nearest.separation
    return {
      x: nearest.foot.x + (point.x - nearest.foot.x) * scale,
      y: nearest.foot.y + (point.y - nearest.foot.y) * scale,
      rawOffset,
      locked: false,
      shorelineFactor,
    }
  })
}

/**
 * The nearest point on the chain's own raw boundary within a local arc window of one offset.
 * The window keeps the clamp honest at concave corners and stops a smoothed small closed chain
 * from hiding near a far side of its own ring.
 */
function nearestOwnSegment(
  chain: WorkingChain,
  point: ContourCoordinate,
  rawOffset: number,
): { readonly foot: ContourCoordinate; readonly separation: number; readonly footOffset: number } {
  const spans = chain.spans
  const count = spans.length
  let lower = 0
  let upper = count - 1
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2)
    if (spans[middle]!.endOffset > rawOffset + EPSILON) upper = middle
    else lower = middle + 1
  }
  const measure = (
    index: number,
  ): { foot: ContourCoordinate; separation: number; footOffset: number } => {
    const start = chain.rawPoints[index]
    const end = chain.rawPoints[index + 1]
    const span = spans[index]
    if (start === undefined || end === undefined || span === undefined) {
      throw new Error('Terrain contour clamp segment is missing its raw points.')
    }
    const foot = projectToSegment(point, start, end)
    return {
      foot,
      separation: distance(point, foot),
      footOffset: span.startOffset + distance(start, foot),
    }
  }
  let best = measure(lower)
  for (const direction of [-1, 1] as const) {
    let index = lower
    for (let step = 0; step < count - 1; step += 1) {
      let next = index + direction
      if (chain.closed) next = (next + count) % count
      else if (next < 0 || next >= count) break
      const span = spans[next]
      if (span === undefined) break
      const arcDistance = circularDistanceToInterval(
        rawOffset,
        span.startOffset,
        span.endOffset,
        chain.rawLength,
        chain.closed,
      )
      if (arcDistance > CLAMP_WINDOW_CELLS + EPSILON) break
      const candidate = measure(next)
      if (candidate.separation < best.separation) best = candidate
      index = next
    }
  }
  return best
}

function curveSourcePoints(
  rawPoints: readonly ContourCoordinate[],
  spans: readonly TerrainContourSpan[],
  rawLength: number,
  closed: boolean,
  lockOffsets: readonly number[],
  spanIndex: ContourSpanIndex,
  tangentLength: number,
): TerrainCurveSourcePoint[] {
  const offsets = new Map<string, number>()
  for (const offset of [...spans.map((span) => span.startOffset), ...lockOffsets]) {
    const normalized = normalizedOffset(offset, rawLength, closed)
    offsets.set(contourOffsetKey(normalized), normalized)
  }
  if (!closed) offsets.set(contourOffsetKey(rawLength), rawLength)
  return [...offsets.values()]
    .sort((first, second) => first - second)
    .map((offset) => ({
      ...rawPointAt(offset, rawPoints, spans, rawLength, closed),
      locked: offsetLocked(offset, spanIndex.fixed, rawLength, closed, tangentLength),
    }))
}

function indexContourSpans(spans: readonly TerrainContourSpan[]): ContourSpanIndex {
  const byStartOffset = (first: OffsetInterval, second: OffsetInterval): number =>
    first.startOffset - second.startOffset
  return {
    spans,
    fixed: spans.filter((span) => span.fixed).sort(byStartOffset),
    bridgeSuppressed: spans.filter((span) => span.bridgeSuppressed).sort(byStartOffset),
    hasShoreline: spans.some((span) => span.shoreline),
  }
}

function contourLockOffsets(
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

function contourOffsetKey(offset: number): string {
  return offset.toFixed(9)
}

function normalizedOffset(offset: number, rawLength: number, closed: boolean): number {
  if (!closed) return Math.max(0, Math.min(rawLength, offset))
  const normalized = offset % rawLength
  return normalized < 0 ? normalized + rawLength : normalized
}

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

function offsetLocked(
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

function shorelineFactorAt(
  offset: number,
  spanIndex: ContourSpanIndex,
  rawLength: number,
  closed: boolean,
  taperCells: number,
): number {
  if (!spanIndex.hasShoreline) return 0
  if (spanIndex.bridgeSuppressed.length === 0) return 1
  const normalized = normalizedOffset(offset, rawLength, closed)
  const distance = nearestIntervalDistance(
    normalized,
    spanIndex.bridgeSuppressed,
    rawLength,
    closed,
  )
  if (taperCells === 0) return distance <= EPSILON ? 0 : 1
  return Math.min(1, distance / taperCells)
}

function nearestIntervalDistance(
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

/** A raw source-polyline segment used by curve validation. */
export interface RawPolylineSegment {
  readonly start: ContourCoordinate
  readonly end: ContourCoordinate
}

/** A cell-bucketed index of raw source-polyline segments. */
export interface RawPolylineIndex {
  readonly segments: readonly RawPolylineSegment[]
  readonly buckets: ReadonlyMap<string, readonly RawPolylineSegment[]>
}

/** Index raw source segments by cell so local contour adjustments avoid full-chain scans. */
export function indexRawPolyline(points: readonly ContourCoordinate[]): RawPolylineIndex {
  const segments = points.slice(0, -1).map((start, index) => ({ start, end: points[index + 1]! }))
  const buckets = new Map<string, RawPolylineSegment[]>()
  for (const segment of segments) {
    const minimumX = Math.floor(Math.min(segment.start.x, segment.end.x))
    const maximumX = Math.floor(Math.max(segment.start.x, segment.end.x))
    const minimumY = Math.floor(Math.min(segment.start.y, segment.end.y))
    const maximumY = Math.floor(Math.max(segment.start.y, segment.end.y))
    for (let y = minimumY; y <= maximumY; y += 1) {
      for (let x = minimumX; x <= maximumX; x += 1) {
        const key = cellKey(x, y)
        const bucket = buckets.get(key) ?? []
        bucket.push(segment)
        buckets.set(key, bucket)
      }
    }
  }
  return { segments, buckets }
}

export function projectToPolyline(
  point: ContourCoordinate,
  index: RawPolylineIndex,
): { point: ContourCoordinate; distance: number } {
  const nearby = nearbyRawSegments(point, index)
  const candidates = nearby.length === 0 ? index.segments : nearby
  let nearest: ContourCoordinate = candidates[0]?.start ?? point
  let nearestDistance = Number.POSITIVE_INFINITY
  for (const segment of candidates) {
    const projected = projectToSegment(point, segment.start, segment.end)
    const candidateDistance = distance(point, projected)
    if (candidateDistance < nearestDistance) {
      nearest = projected
      nearestDistance = candidateDistance
    }
  }
  return { point: nearest, distance: nearestDistance }
}

/** Return raw segments in the point cell and its eight neighbors, without duplicate probes. */
function nearbyRawSegments(
  point: ContourCoordinate,
  index: RawPolylineIndex,
): readonly RawPolylineSegment[] {
  const column = Math.floor(point.x)
  const row = Math.floor(point.y)
  const segments = new Set<RawPolylineSegment>()
  for (let y = row - 1; y <= row + 1; y += 1) {
    for (let x = column - 1; x <= column + 1; x += 1) {
      for (const segment of index.buckets.get(cellKey(x, y)) ?? []) segments.add(segment)
    }
  }
  return [...segments]
}

/** Shape every raw chain after the global clearance index has been built. */
export function shapeChains(
  chains: readonly WorkingChain[],
  settings: TerrainContourSettings,
  bridgeTaperCells: number,
  layoutHash: number,
  clearanceIndex: ClearanceIndex,
): void {
  for (const chain of chains) {
    chain.points = shapeContourChain(chain, settings, bridgeTaperCells, layoutHash, clearanceIndex)
  }
}
