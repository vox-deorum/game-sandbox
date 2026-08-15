import { distance } from '@renderers/base/math.js'

import { EPSILON, cellKey, projectToSegment } from './terrain-helpers.js'
import { samePoint } from './terrain-contour-graph.js'
import { referenceOf, referencePointAtRawOffset } from './terrain-contour-reference.js'
import { indexRawPolyline, projectToPolyline } from './terrain-contour-shaping.js'
import type { ComponentRecord } from './terrain-contour-grid.js'
import type { WorkingChain } from './terrain-contour-graph.js'
import type { WorkingRing } from './terrain-contour-rings.js'
import type { ContourCoordinate, TerrainContourPoint, TerrainContourUse } from './types.js'
import type { RawPolylineIndex } from './terrain-contour-shaping.js'
const CURVE_BUCKET_SIZE_CELLS = 1

interface CurvePiece {
  readonly chain: WorkingChain
  readonly referenceIndex: RawPolylineIndex
  readonly index: number
  readonly start: ContourCoordinate
  readonly end: ContourCoordinate
  readonly count: number
}

/**
 * Shaping constrains sample points, so chords between samples may sag past the point bound,
 * most where tangential slide and the lock blend stretch the spacing between emitted points.
 * Validation allows that interpolation sag; it is a tripwire for construction failures, which
 * overshoot by half a cell or more, not a second calibration bound.
 */
const VALIDATION_SAG_CELLS = 0.08
const TUBE_SAMPLE_SPACING_CELLS = 0.05

/** The corner-cut reference polyline of one chain, with the seam point repeated when closed. */
function referencePolyline(chain: WorkingChain): readonly ContourCoordinate[] {
  const points = referenceOf(chain).points
  return chain.closed ? [...points, points[0]!] : points
}

/** Emitted-curve pieces, closed rings including their seam chord, for sweeps and repair. */
function curvePieces(
  chains: readonly WorkingChain[],
  referenceIndexes: ReadonlyMap<WorkingChain, RawPolylineIndex>,
): CurvePiece[] {
  return chains.flatMap((chain) => {
    if (chain.points.length < 2) throw new Error('Terrain contour chain emitted too few points.')
    const points = chain.closed ? [...chain.points, chain.points[0]!] : chain.points
    const referenceIndex = referenceIndexes.get(chain)!
    return points.slice(0, -1).map((start, index) => ({
      chain,
      referenceIndex,
      index,
      start,
      end: points[index + 1]!,
      count: points.length - 1,
    }))
  })
}

/** Every pair of emitted pieces that truly cross, excluding shared endpoints and junctions. */
function nonincidentIntersections(
  pieces: readonly CurvePiece[],
): readonly (readonly [CurvePiece, CurvePiece])[] {
  const found: [CurvePiece, CurvePiece][] = []
  for (const [first, second] of spatialCurvePairs(pieces)) {
    if (
      first.chain === second.chain &&
      piecesAreAdjacent(first, second) &&
      adjacentPiecesMeetOnlyAtEndpoint(first, second)
    ) {
      continue
    }
    if (!segmentsIntersect(first.start, first.end, second.start, second.end)) continue
    if (adjacentPiecesMeetOnlyAtEndpoint(first, second) || incidentIntersection(first, second))
      continue
    found.push([first, second])
  }
  return found
}

/**
 * Rare tip geometry can smooth two stretches of boundary across each other, and no local
 * envelope can tell those stretches apart in time. Repair directly instead: pull the points of
 * every crossing piece halfway toward their reference positions and sweep again. The corner-cut
 * reference is planar, so the halving always converges without reintroducing staircase corners.
 */
const INTERSECTION_REPAIR_PASSES = 12

export function repairAndValidateCurveGraph(
  chains: readonly WorkingChain[],
  maxDeviation: number,
): void {
  const referenceIndexes = new Map(
    chains.map((chain) => [chain, indexRawPolyline(referencePolyline(chain))]),
  )
  let pieces = curvePieces(chains, referenceIndexes)
  for (let pass = 0; pass < INTERSECTION_REPAIR_PASSES; pass += 1) {
    const offenders = nonincidentIntersections(pieces)
    if (offenders.length === 0) break
    const indexesByChain = new Map<WorkingChain, Set<number>>()
    for (const [first, second] of offenders) {
      for (const piece of [first, second]) {
        const indexes = indexesByChain.get(piece.chain) ?? new Set<number>()
        indexes.add(piece.index)
        indexes.add((piece.index + 1) % piece.chain.points.length)
        indexesByChain.set(piece.chain, indexes)
      }
    }
    for (const [chain, indexes] of indexesByChain) {
      const points = [...chain.points]
      for (const index of indexes) {
        const point = points[index]
        if (point === undefined || point.locked) continue
        const anchor = referencePointAtRawOffset(
          referenceOf(chain),
          chain.closed,
          chain.rawLength,
          point.rawOffset,
        )
        points[index] = {
          ...point,
          x: anchor.x + (point.x - anchor.x) * 0.5,
          y: anchor.y + (point.y - anchor.y) * 0.5,
        }
      }
      chain.points = points
    }
    pieces = curvePieces(chains, referenceIndexes)
  }
  const allowed = maxDeviation + VALIDATION_SAG_CELLS
  for (const piece of pieces) {
    const tube = segmentTubeDeviation(piece.start, piece.end, piece.referenceIndex)
    if (tube.worst + tube.spacing / 2 > allowed + 1e-7) {
      throw new Error(
        `Terrain contour curve escaped its reference tube: chain ${piece.chain.id} ` +
          `(${piece.chain.leftMaterial} against ${piece.chain.rightMaterial}) near ` +
          `(${piece.start.x.toFixed(2)}, ${piece.start.y.toFixed(2)}) deviates ` +
          `${tube.worst.toFixed(3)} of ${allowed.toFixed(3)} allowed cells.`,
      )
    }
  }
  const offenders = nonincidentIntersections(pieces)
  const offending = offenders[0]
  if (offending !== undefined) {
    const [first, second] = offending
    throw new Error(
      `Terrain contour curves contain a nonincident intersection: chain ${first.chain.id} ` +
        `(${first.chain.leftMaterial} against ${first.chain.rightMaterial}) crosses chain ` +
        `${second.chain.id} near (${first.start.x.toFixed(2)}, ${first.start.y.toFixed(2)}).`,
    )
  }
}

/** Return each pair of locally overlapping curve pieces once in deterministic insertion order. */
function spatialCurvePairs(
  pieces: readonly CurvePiece[],
): readonly (readonly [CurvePiece, CurvePiece])[] {
  const buckets = new Map<string, CurvePiece[]>()
  const indexes = new Map(pieces.map((piece, index) => [piece, index]))
  const pairs: [CurvePiece, CurvePiece][] = []
  const seen = new Set<string>()
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index]!
    for (const key of curveBucketKeys(piece)) {
      const bucket = buckets.get(key) ?? []
      for (const earlier of bucket) {
        const pairKey = `${indexes.get(earlier)!}:${index}`
        if (seen.has(pairKey)) continue
        seen.add(pairKey)
        pairs.push([earlier, piece])
      }
      bucket.push(piece)
      buckets.set(key, bucket)
    }
  }
  return pairs
}

function curveBucketKeys(piece: Pick<CurvePiece, 'start' | 'end'>): readonly string[] {
  const minimumX = Math.floor(Math.min(piece.start.x, piece.end.x) / CURVE_BUCKET_SIZE_CELLS)
  const maximumX = Math.floor(Math.max(piece.start.x, piece.end.x) / CURVE_BUCKET_SIZE_CELLS)
  const minimumY = Math.floor(Math.min(piece.start.y, piece.end.y) / CURVE_BUCKET_SIZE_CELLS)
  const maximumY = Math.floor(Math.max(piece.start.y, piece.end.y) / CURVE_BUCKET_SIZE_CELLS)
  const keys: string[] = []
  for (let y = minimumY; y <= maximumY; y += 1) {
    for (let x = minimumX; x <= maximumX; x += 1) keys.push(`${x}:${y}`)
  }
  return keys
}

/** Sample a chord closely enough to certify its full 1-Lipschitz distance bound. */
function segmentTubeDeviation(
  start: ContourCoordinate,
  end: ContourCoordinate,
  referenceIndex: RawPolylineIndex,
): { readonly worst: number; readonly spacing: number } {
  const steps = Math.max(1, Math.ceil(distance(start, end) / TUBE_SAMPLE_SPACING_CELLS))
  const spacing = distance(start, end) / steps
  let worst = 0
  for (let step = 0; step <= steps; step += 1) {
    const amount = step / steps
    const point = {
      x: start.x + (end.x - start.x) * amount,
      y: start.y + (end.y - start.y) * amount,
    }
    worst = Math.max(worst, projectToPolyline(point, referenceIndex).distance)
  }
  return { worst, spacing }
}

function piecesAreAdjacent(
  first: { readonly chain: WorkingChain; readonly index: number; readonly count: number },
  second: { readonly chain: WorkingChain; readonly index: number; readonly count: number },
): boolean {
  if (Math.abs(first.index - second.index) === 1) return true
  return (
    first.chain.closed &&
    new Set([first.index, second.index]).has(0) &&
    new Set([first.index, second.index]).has(first.count - 1)
  )
}

function adjacentPiecesMeetOnlyAtEndpoint(
  first: { readonly start: ContourCoordinate; readonly end: ContourCoordinate },
  second: { readonly start: ContourCoordinate; readonly end: ContourCoordinate },
): boolean {
  const shared = [first.start, first.end].find(
    (point) => samePoint(point, second.start) || samePoint(point, second.end),
  )
  if (shared === undefined) return false
  const firstOther = samePoint(first.start, shared) ? first.end : first.start
  const secondOther = samePoint(second.start, shared) ? second.end : second.start
  const firstVector = { x: firstOther.x - shared.x, y: firstOther.y - shared.y }
  const secondVector = { x: secondOther.x - shared.x, y: secondOther.y - shared.y }
  const cross = firstVector.x * secondVector.y - firstVector.y * secondVector.x
  if (Math.abs(cross) > EPSILON) return true
  return firstVector.x * secondVector.x + firstVector.y * secondVector.y <= EPSILON
}

function incidentIntersection(
  first: {
    readonly chain: WorkingChain
    readonly start: ContourCoordinate
    readonly end: ContourCoordinate
  },
  second: {
    readonly chain: WorkingChain
    readonly start: ContourCoordinate
    readonly end: ContourCoordinate
  },
): boolean {
  if (first.chain.closed || second.chain.closed) return false
  const firstEndpoints = [
    first.chain.points[0]!,
    first.chain.points[first.chain.points.length - 1]!,
  ]
  const secondEndpoints = [
    second.chain.points[0]!,
    second.chain.points[second.chain.points.length - 1]!,
  ]
  return firstEndpoints.some((firstEndpoint) =>
    secondEndpoints.some(
      (secondEndpoint) =>
        samePoint(firstEndpoint, secondEndpoint) &&
        (samePoint(first.start, firstEndpoint) || samePoint(first.end, firstEndpoint)) &&
        (samePoint(second.start, secondEndpoint) || samePoint(second.end, secondEndpoint)),
    ),
  )
}

function segmentsIntersect(
  firstStart: ContourCoordinate,
  firstEnd: ContourCoordinate,
  secondStart: ContourCoordinate,
  secondEnd: ContourCoordinate,
): boolean {
  const firstSide = orientation(firstStart, firstEnd, secondStart)
  const secondSide = orientation(firstStart, firstEnd, secondEnd)
  const thirdSide = orientation(secondStart, secondEnd, firstStart)
  const fourthSide = orientation(secondStart, secondEnd, firstEnd)
  if (
    ((firstSide > EPSILON && secondSide < -EPSILON) ||
      (firstSide < -EPSILON && secondSide > EPSILON)) &&
    ((thirdSide > EPSILON && fourthSide < -EPSILON) ||
      (thirdSide < -EPSILON && fourthSide > EPSILON))
  ) {
    return true
  }
  return (
    (Math.abs(firstSide) <= EPSILON && pointOnSegment(secondStart, firstStart, firstEnd)) ||
    (Math.abs(secondSide) <= EPSILON && pointOnSegment(secondEnd, firstStart, firstEnd)) ||
    (Math.abs(thirdSide) <= EPSILON && pointOnSegment(firstStart, secondStart, secondEnd)) ||
    (Math.abs(fourthSide) <= EPSILON && pointOnSegment(firstEnd, secondStart, secondEnd))
  )
}

function orientation(
  start: ContourCoordinate,
  end: ContourCoordinate,
  point: ContourCoordinate,
): number {
  return (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x)
}

function pointOnSegment(
  point: ContourCoordinate,
  start: ContourCoordinate,
  end: ContourCoordinate,
): boolean {
  return (
    point.x >= Math.min(start.x, end.x) - EPSILON &&
    point.x <= Math.max(start.x, end.x) + EPSILON &&
    point.y >= Math.min(start.y, end.y) - EPSILON &&
    point.y <= Math.max(start.y, end.y) + EPSILON
  )
}

export function validatePartition(
  chains: readonly WorkingChain[],
  rings: readonly WorkingRing[],
  components: readonly ComponentRecord[],
): void {
  const uses = new Map<string, TerrainContourUse[]>()
  for (const ring of rings) {
    if (
      ring.points.length < 4 ||
      !samePoint(ring.points[0]!, ring.points[ring.points.length - 1]!)
    ) {
      throw new Error('Terrain contour face is open.')
    }
    for (const use of ring.uses) {
      const owned = uses.get(use.chainId) ?? []
      owned.push(use)
      uses.set(use.chainId, owned)
    }
  }
  for (const chain of chains) {
    const owned = uses.get(chain.id) ?? []
    if (owned.length !== 2 || owned[0]!.reversed === owned[1]!.reversed) {
      throw new Error('Terrain contour shared chain must have exact reversed ownership.')
    }
  }
  if (uses.size !== chains.length)
    throw new Error('Terrain contour rings reference an unknown shared chain.')
  for (const component of components) {
    if (component.outerRingId === '')
      throw new Error('Terrain contour component has no outer face.')
  }
}
