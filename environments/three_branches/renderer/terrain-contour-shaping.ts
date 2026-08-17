import { distance, stableHashParts } from '@renderers/base/math.js'

import { cellKey, EPSILON, projectToSegment } from './terrain-helpers.js'
import {
  buildContourReference,
  nearestIntervalDistance,
  normalizedOffset,
  offsetLocked,
  rawOffsetAtReferenceOffset,
  rawPointAt,
  referenceOf,
} from './terrain-contour-reference.js'
import { shapeTerrainCurve } from './terrain-curves.js'
import type { OffsetInterval } from './terrain-contour-reference.js'
import type {
  ContourCoordinate,
  TerrainContourPoint,
  TerrainContourSettings,
  TerrainContourSpan,
  TerrainCurveSourcePoint,
} from './types.js'
import type { WorkingChain } from './terrain-contour-graph.js'

interface ContourSpanIndex {
  readonly spans: readonly TerrainContourSpan[]
  readonly fixed: readonly OffsetInterval[]
  readonly bridgeSuppressed: readonly OffsetInterval[]
  readonly hasShoreline: boolean
}

/**
 * Shape one chain. The corner-cut reference supplies the source polyline, junction tangents and
 * fixed spans stay locked on raw geometry, and the deviation cap bounds smoothing and noise alike.
 */
function shapeContourChain(
  chain: WorkingChain,
  settings: TerrainContourSettings,
  bridgeTaperCells: number,
  layoutHash: number,
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
    () => settings.maxDeviationCells,
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
 * a corridor open.
 */
export function buildContourReferences(
  chains: readonly WorkingChain[],
  settings: TerrainContourSettings,
): void {
  for (const chain of chains) {
    chain.reference = buildContourReference(chain, settings.junctionTangentCells)
  }
}

/** Shape every chain once its reference has been built. */
export function shapeChains(
  chains: readonly WorkingChain[],
  settings: TerrainContourSettings,
  bridgeTaperCells: number,
  layoutHash: number,
): void {
  for (const chain of chains) {
    chain.points = shapeContourChain(chain, settings, bridgeTaperCells, layoutHash)
  }
}
