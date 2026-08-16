import { distance, stableHashParts } from '@renderers/base/math.js'

import { samePoint } from './terrain-contour-graph.js'
import {
  cellKey,
  EPSILON,
  pointToSegmentDistance,
  projectToSegment,
  required,
} from './terrain-helpers.js'
import {
  buildContourReference,
  circularDistanceToInterval,
  nearestIntervalDistance,
  normalizedOffset,
  offsetLocked,
  rawOffsetAtReferenceOffset,
  rawPointAt,
  referenceIntervalAt,
  referenceOf,
} from './terrain-contour-reference.js'
import { shapeTerrainCurve } from './terrain-curves.js'
import type { OffsetInterval } from './terrain-contour-reference.js'
import type {
  ContourCoordinate,
  TerrainContourPoint,
  TerrainContourSettings,
  TerrainContourSpan,
  TerrainCurveBudget,
  TerrainCurveSourcePoint,
} from './types.js'
import type { WorkingChain } from './terrain-contour-graph.js'

interface ContourSpanIndex {
  readonly spans: readonly TerrainContourSpan[]
  readonly fixed: readonly OffsetInterval[]
  readonly bridgeSuppressed: readonly OffsetInterval[]
  readonly hasShoreline: boolean
}

/** One polyline of one chain, offered to the clearance index in raw or reference form. */
interface ClearancePolyline {
  readonly chain: WorkingChain
  readonly points: readonly ContourCoordinate[]
  readonly offsets: readonly number[]
  readonly length: number
}

/** One indexed segment tagged with its owning chain and arc interval. */
interface ClearanceSegment {
  readonly chain: WorkingChain
  readonly start: ContourCoordinate
  readonly end: ContourCoordinate
  readonly startOffset: number
  readonly endOffset: number
  readonly ownerLength: number
}

/** Cell-bucketed boundary segments of every chain, queried one chain at a time. */
type ClearanceIndex = ReadonlyMap<string, readonly ClearanceSegment[]>

/**
 * Clearance beyond this many cells never tightens the envelope, so the query stays local. Both
 * ceilings saturate once a competitor is more than one corridor plus twice the deviation away,
 * which is under two cells, and a segment that far always lands in a bucket this reach covers.
 */
const CLEARANCE_SEARCH_CELLS = 2

/**
 * How fast the displacement budget may grow along the arc, in cells per cell. A curve leaving a
 * lock has to reach its full budget over a stretch of boundary rather than at one point, and half
 * a cell of freedom per cell travelled is the slope at which that approach still reads as drawn
 * rather than kinked.
 */
const BUDGET_SLOPE = 0.5

/**
 * A segment of the boundary a sample sits on competes for clearance only when its arc distance is
 * clearly larger than its straight-line distance. Local continuation stays excluded so it can
 * smooth. Facing walls of an inlet or hairpin sit at ratio two and above and must count, or the
 * two sides smooth across their corridor into each other. A staircase holds ratio near 1.4, so
 * this bound leaves it free to flatten while still catching a genuine fold.
 */
const SELF_FOLD_ARC_RATIO = 1.6

/** Arc reach within which a chain never competes with itself, whatever the ratio says. */
const SELF_ARC_WINDOW_CELLS = 1.4

/** Index the shaped reference of every chain. */
export function buildClearanceIndex(chains: readonly WorkingChain[]): ClearanceIndex {
  return buildIndex(
    chains.map((chain) => {
      const reference = referenceOf(chain)
      return {
        chain,
        points: reference.points,
        offsets: reference.offsets,
        length: reference.length,
      }
    }),
  )
}

function buildIndex(polylines: readonly ClearancePolyline[]): ClearanceIndex {
  const buckets = new Map<string, ClearanceSegment[]>()
  for (const polyline of polylines) {
    const { chain, points, offsets, length } = polyline
    const count = chain.closed ? points.length : points.length - 1
    for (let index = 0; index < count; index += 1) {
      const start = required(points[index], 'Terrain clearance segment is missing its start.')
      const end = required(
        points[(index + 1) % points.length],
        'Terrain clearance segment is missing its end.',
      )
      const segment: ClearanceSegment = {
        chain,
        start,
        end,
        startOffset: required(offsets[index], 'Terrain clearance segment has no offset.'),
        endOffset: index + 1 < offsets.length ? offsets[index + 1]! : length,
        ownerLength: length,
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
 * Distance from one sample to the nearest competing boundary.
 *
 * A segment counts only where its distance really is a corridor. Segments of the same chain, and
 * segments of a chain meeting this one at a junction, are measured along the boundary as well and
 * drop out while that arc still tracks their straight-line distance: a chain smoothing along
 * itself, and two branches leaving a junction, separate about as fast as the boundary runs, so
 * neither ever pinches the other. A hairpin or a narrow wedge folds back faster than that, stays
 * in, and keeps its corridor.
 */
export function clearanceAt(
  index: ClearanceIndex,
  chain: WorkingChain,
  point: ContourCoordinate,
  sourceOffset: number,
): number {
  const ownLength = referenceOf(chain).length
  const column = Math.floor(point.x)
  const row = Math.floor(point.y)
  let nearest = Number.POSITIVE_INFINITY
  for (let y = row - CLEARANCE_SEARCH_CELLS; y <= row + CLEARANCE_SEARCH_CELLS; y += 1) {
    for (let x = column - CLEARANCE_SEARCH_CELLS; x <= column + CLEARANCE_SEARCH_CELLS; x += 1) {
      for (const segment of index.get(cellKey(x, y)) ?? []) {
        const separation = pointToSegmentDistance(point, segment.start, segment.end)
        if (separation >= nearest) continue
        if (segment.chain === chain) {
          const arcDistance = circularDistanceToInterval(
            normalizedOffset(sourceOffset, segment.ownerLength, chain.closed),
            segment.startOffset,
            segment.endOffset,
            segment.ownerLength,
            chain.closed,
          )
          const window = Math.max(SELF_ARC_WINDOW_CELLS, SELF_FOLD_ARC_RATIO * separation)
          if (arcDistance <= window + EPSILON) continue
        }
        const junction = junctionArc(chain, ownLength, sourceOffset, segment)
        if (junction <= SELF_FOLD_ARC_RATIO * separation + EPSILON) continue
        nearest = separation
      }
    }
  }
  return nearest
}

/**
 * Arc from one sample to a competing segment through a node the two chains share, infinite when
 * they share none. An open chain ends on the junction it meets, so a chain carrying on across that
 * junction is this boundary running on rather than a bank facing it. Closed chains only ever pass
 * through nodes of their own, so they share none.
 */
function junctionArc(
  chain: WorkingChain,
  ownLength: number,
  sourceOffset: number,
  segment: ClearanceSegment,
): number {
  if (chain.closed || segment.chain.closed) return Number.POSITIVE_INFINITY
  const offset = Math.max(0, Math.min(ownLength, sourceOffset))
  const ownEnds = [
    { point: chain.rawPoints[0]!, arc: offset },
    { point: chain.rawPoints.at(-1)!, arc: ownLength - offset },
  ]
  const otherEnds = [
    { point: segment.chain.rawPoints[0]!, arc: segment.startOffset },
    { point: segment.chain.rawPoints.at(-1)!, arc: segment.ownerLength - segment.endOffset },
  ]
  let nearest = Number.POSITIVE_INFINITY
  for (const own of ownEnds) {
    for (const other of otherEnds) {
      if (samePoint(own.point, other.point)) nearest = Math.min(nearest, own.arc + other.arc)
    }
  }
  return nearest
}

/**
 * The displacement ceiling one chain may use at a sample, from the clearance to its competitors.
 * Both sides of a corridor may spend half the slack beyond the corridor width, so measuring the
 * ceiling against raw geometry keeps every reference at least one corridor from its neighbors.
 */
export function clearanceCeiling(
  clearance: number,
  settings: TerrainContourSettings,
  maximum: number,
): number {
  return Math.max(0, Math.min(maximum, (clearance - settings.minimumCorridorCells) / 2))
}

/**
 * How far one chain may leave its reference at each reference vertex.
 *
 * The budget is built on the static reference, before any curve moves, so shaping is bounded by
 * construction rather than corrected afterwards. Every free point starts with half the slack it
 * has beyond the corridor to competing boundaries, which leaves both sides of a corridor free to
 * spend their own half without the two ever meeting, and locks hold zero. Eroding along the arc
 * then limits how fast the budget may grow, so it can never step between neighbouring samples: a
 * bound that jumps is what puts a kink in an otherwise smooth curve.
 */
function buildDisplacementBudget(
  chain: WorkingChain,
  settings: TerrainContourSettings,
  clearanceIndex: ClearanceIndex,
): TerrainCurveBudget {
  const reference = referenceOf(chain)
  const count = reference.points.length
  const offsetAt = (index: number): number =>
    required(reference.offsets[index], 'Terrain reference offset is missing.')
  const cells = reference.points.map((point, index) =>
    reference.locked[index] === true
      ? 0
      : clearanceCeiling(
          clearanceAt(clearanceIndex, chain, point, offsetAt(index)),
          settings,
          settings.maxDeviationCells,
        ),
  )
  const stepTo = (index: number): number =>
    index === 0 ? reference.length - offsetAt(count - 1) : offsetAt(index) - offsetAt(index - 1)
  for (let lap = 0; lap < (chain.closed ? 2 : 1); lap += 1) {
    for (let index = chain.closed ? 0 : 1; index < count; index += 1) {
      const previous = (index - 1 + count) % count
      cells[index] = Math.min(cells[index]!, cells[previous]! + BUDGET_SLOPE * stepTo(index))
    }
    for (let index = chain.closed ? count - 1 : count - 2; index >= 0; index -= 1) {
      const next = (index + 1) % count
      cells[index] = Math.min(cells[index]!, cells[next]! + BUDGET_SLOPE * stepTo(next))
    }
  }
  return (sourceOffset) => {
    const { startIndex, amount } = referenceIntervalAt(reference, chain.closed, sourceOffset)
    const start = cells[startIndex]!
    const end = startIndex + 1 < count ? cells[startIndex + 1]! : chain.closed ? cells[0]! : start
    return start + (end - start) * amount
  }
}

/**
 * Shape one chain. The corner-cut reference supplies the source polyline, junction tangents and
 * fixed spans stay locked on raw geometry, and the displacement budget bounds smoothing and noise
 * alike.
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
  const shaped = shapeTerrainCurve(
    source,
    chain.closed,
    profile,
    stableHashParts('terrain-contour-shape', layoutHash, chain.pairKey),
    buildDisplacementBudget(chain, settings, clearanceIndex),
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
      const raw = rawPointAt(
        rawOffset,
        chain.rawPoints,
        spanIndex.spans,
        chain.rawLength,
        chain.closed,
      )
      return { x: raw.x, y: raw.y, rawOffset, locked: true, shorelineFactor }
    }
    return { x: point.x, y: point.y, rawOffset, locked: false, shorelineFactor }
  })
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

/**
 * Build the reference of every chain.
 *
 * Every reference leaves its raw boundary by the same drift bound, so two banks of a thin band
 * shed the same staircase and travel together, keeping the width between them. That is what holds
 * a corridor open here, and the displacement budget below spends only half of whatever slack is
 * left, so neither bank can close on the other later.
 */
export function buildContourReferences(
  chains: readonly WorkingChain[],
  settings: TerrainContourSettings,
): void {
  for (const chain of chains) {
    chain.reference = buildContourReference(chain, settings.junctionTangentCells)
  }
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
