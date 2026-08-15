import { distance, stableHashParts } from '@renderers/base/math.js'

import { cellKey, EPSILON, pointToSegmentDistance, projectToSegment } from './terrain-helpers.js'
import {
  circularDistanceToInterval,
  nearestIntervalDistance,
  normalizedOffset,
  offsetLocked,
  rawOffsetAtReferenceOffset,
  rawPointAt,
  referenceOf,
  referencePointAtReferenceOffset,
  referenceSegmentAt,
  referenceSegmentCount,
} from './terrain-contour-reference.js'
import { shapeTerrainCurve } from './terrain-curves.js'
import type { OffsetInterval } from './terrain-contour-reference.js'
import type {
  ContourCoordinate,
  ContourReference,
  TerrainContourPoint,
  TerrainContourSettings,
  TerrainContourSpan,
  TerrainCurveEnvelope,
  TerrainCurveSourcePoint,
} from './types.js'
import type { WorkingChain } from './terrain-contour-graph.js'

interface ContourSpanIndex {
  readonly spans: readonly TerrainContourSpan[]
  readonly fixed: readonly OffsetInterval[]
  readonly bridgeSuppressed: readonly OffsetInterval[]
  readonly hasShoreline: boolean
}

/** One reference segment tagged with its owning chain and arc interval for clearance queries. */
interface ClearanceSegment {
  readonly chain: WorkingChain
  readonly start: ContourCoordinate
  readonly end: ContourCoordinate
  readonly startOffset: number
  readonly endOffset: number
}

/** Cell-bucketed reference segments of every chain, queried while each single chain is shaped. */
type ClearanceIndex = ReadonlyMap<string, readonly ClearanceSegment[]>

/** Clearance beyond this many cells never tightens the envelope, so the query stays local. */
const CLEARANCE_SEARCH_CELLS = 3

/** Arc reach when clamping a shaped point against its own local stretch of reference boundary. */
const CLAMP_WINDOW_CELLS = 2.5

/**
 * A same-chain segment competes for clearance only when its arc distance is clearly larger than
 * its straight-line distance. Local continuation stays excluded so it can smooth. Facing walls of
 * an inlet or hairpin sit at ratio two and above and must count, or the two sides smooth across
 * their corridor into each other. The corner-cut reference holds ratio near one on straight and
 * diagonal runs, so this bound keeps a comfortable margin.
 */
const SELF_FOLD_ARC_RATIO = 1.6

export function buildClearanceIndex(chains: readonly WorkingChain[]): ClearanceIndex {
  const buckets = new Map<string, ClearanceSegment[]>()
  for (const chain of chains) {
    const reference = referenceOf(chain)
    const count = referenceSegmentCount(reference, chain.closed)
    for (let index = 0; index < count; index += 1) {
      const { start, end, startOffset, endOffset } = referenceSegmentAt(
        reference,
        chain.closed,
        index,
      )
      const segment: ClearanceSegment = { chain, start, end, startOffset, endOffset }
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
 * Distance from one reference sample to the nearest competing reference segment. Segments of the
 * same chain count only beyond a short arc window, so a serpentine chain cannot pinch its own
 * corridor.
 */
function clearanceAt(
  index: ClearanceIndex,
  chain: WorkingChain,
  point: ContourCoordinate,
  sourceOffset: number,
  arcWindowCells: number,
): number {
  const referenceLength = referenceOf(chain).length
  const column = Math.floor(point.x)
  const row = Math.floor(point.y)
  let nearest = Number.POSITIVE_INFINITY
  for (let y = row - CLEARANCE_SEARCH_CELLS; y <= row + CLEARANCE_SEARCH_CELLS; y += 1) {
    for (let x = column - CLEARANCE_SEARCH_CELLS; x <= column + CLEARANCE_SEARCH_CELLS; x += 1) {
      for (const segment of index.get(cellKey(x, y)) ?? []) {
        const separation = pointToSegmentDistance(point, segment.start, segment.end)
        if (segment.chain === chain) {
          const arcDistance = circularDistanceToInterval(
            normalizedOffset(sourceOffset, referenceLength, chain.closed),
            segment.startOffset,
            segment.endOffset,
            referenceLength,
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
 * Shape one chain. The corner-cut reference supplies the source polyline, junction tangents and
 * fixed spans stay locked on raw geometry, octave noise fades under the clearance envelope, and
 * every free point is finally clamped to that envelope so smoothing can never leave the tube
 * either.
 */
function shapeContourChain(
  chain: WorkingChain,
  settings: TerrainContourSettings,
  bridgeTaperCells: number,
  layoutHash: number,
  clearanceIndex: ClearanceIndex,
): readonly TerrainContourPoint[] {
  const reference = referenceOf(chain)
  const spanIndex = indexContourSpans(chain.spans)
  const profile = chain.pairKey.split('\u0000').includes('water')
    ? settings.profiles.water
    : settings.profiles.land
  const source: TerrainCurveSourcePoint[] = reference.points.map((point, index) => ({
    x: point.x,
    y: point.y,
    locked: reference.locked[index] === true,
  }))
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
    const rawOffset = rawOffsetAtReferenceOffset(
      reference,
      chain.closed,
      chain.rawLength,
      point.sourceOffset,
    )
    const shorelineFactor = shorelineFactorAt(
      rawOffset,
      spanIndex,
      chain.rawLength,
      chain.closed,
      bridgeTaperCells,
    )
    const locked = offsetLocked(
      rawOffset,
      spanIndex.fixed,
      chain.rawLength,
      chain.closed,
      settings.junctionTangentCells,
    )
    if (locked) {
      const raw = rawPointAt(rawOffset, chain.rawPoints, spanIndex.spans, chain.rawLength, chain.closed)
      return { x: raw.x, y: raw.y, rawOffset, locked: true, shorelineFactor }
    }
    const anchor = referencePointAtReferenceOffset(reference, chain.closed, point.sourceOffset)
    const nearest = nearestReferenceSegment(reference, chain.closed, point, point.sourceOffset)
    const cap = Math.min(
      envelope(anchor.x, anchor.y, point.sourceOffset),
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
 * The nearest point on the chain's own reference polyline within a local arc window of one
 * offset. The window keeps the clamp honest at concave corners and stops a smoothed small closed
 * chain from hiding near a far side of its own ring.
 */
function nearestReferenceSegment(
  reference: ContourReference,
  closed: boolean,
  point: ContourCoordinate,
  referenceOffset: number,
): { readonly foot: ContourCoordinate; readonly separation: number; readonly footOffset: number } {
  const count = referenceSegmentCount(reference, closed)
  const offsets = reference.offsets
  const points = reference.points
  const endOffsetOf = (index: number): number =>
    index + 1 < offsets.length ? offsets[index + 1]! : reference.length
  const normalized = normalizedOffset(referenceOffset, reference.length, closed)
  let lower = 0
  let upper = count - 1
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2)
    if (endOffsetOf(middle) > normalized + EPSILON) upper = middle
    else lower = middle + 1
  }
  const measure = (
    index: number,
  ): { foot: ContourCoordinate; separation: number; footOffset: number } => {
    const start = points[index]!
    const foot = projectToSegment(point, start, points[(index + 1) % points.length]!)
    return {
      foot,
      separation: distance(point, foot),
      footOffset: offsets[index]! + distance(start, foot),
    }
  }
  let best = measure(lower)
  for (const direction of [-1, 1] as const) {
    let index = lower
    for (let step = 0; step < count - 1; step += 1) {
      let next = index + direction
      if (closed) next = (next + count) % count
      else if (next < 0 || next >= count) break
      const arcDistance = circularDistanceToInterval(
        normalized,
        offsets[next]!,
        endOffsetOf(next),
        reference.length,
        closed,
      )
      if (arcDistance > CLAMP_WINDOW_CELLS + EPSILON) break
      const candidate = measure(next)
      if (candidate.separation < best.separation) best = candidate
      index = next
    }
  }
  return best
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

/** A reference-polyline segment used by curve validation. */
export interface RawPolylineSegment {
  readonly start: ContourCoordinate
  readonly end: ContourCoordinate
}

/** A cell-bucketed index of polyline segments. */
export interface RawPolylineIndex {
  readonly segments: readonly RawPolylineSegment[]
  readonly buckets: ReadonlyMap<string, readonly RawPolylineSegment[]>
}

/** Index polyline segments by cell so local contour adjustments avoid full-chain scans. */
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

/** Return indexed segments in the point cell and its eight neighbors, without duplicate probes. */
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

/** Shape every chain after references and the global clearance index have been built. */
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
