import { stableHashParts } from '@renderers/base/math.js'

import { EPSILON } from './terrain-helpers.js'
import {
  buildContourReference,
  nearestIntervalDistance,
  normalizedOffset,
  offsetLocked,
  rawPointAt,
  referenceOf,
} from './terrain-contour-reference.js'
import { shapeTerrainCurve } from './terrain-curves.js'
import type { OffsetInterval } from './terrain-contour-reference.js'
import type {
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
 * Shape one chain. The reference supplies the source polyline, junction tangents and fixed spans
 * stay locked on raw geometry, and the deviation cap bounds smoothing and noise alike.
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
  // The reference carries every raw corner, so the arc the curve engine resamples along is the raw
  // arc and a sample offset needs only to be brought into range.
  return shaped.map((point): TerrainContourPoint => {
    const rawOffset = normalizedOffset(point.sourceOffset, chain.rawLength, chain.closed)
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

/**
 * Build the reference of every chain. A reference traces its raw boundary exactly, so the two
 * banks of a thin band keep the raw width between them and a corridor stays open.
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
