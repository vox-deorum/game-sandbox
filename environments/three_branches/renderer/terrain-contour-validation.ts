/**
 * Geometry checks over a planned contour graph.
 *
 * Partition ownership is a correctness bound and stays in the renderer: a face that never closes,
 * or a chain a ring does not own once in each direction, means the drawn fills themselves are
 * wrong. The curve sweeps bound shaping calibration instead, so the tests run them across the
 * layout suite and the renderer does not. A curve bulging a tenth of a cell past its tube is still
 * art, while aborting art installation over it drops the whole map back to flat diagnostic colour.
 */

import { distance } from '@renderers/base/math.js'

import { EPSILON } from './terrain-helpers.js'
import { samePoint } from './terrain-contour-graph.js'
import { referenceOf, referencePointAtRawOffset } from './terrain-contour-reference.js'
import { indexRawPolyline, projectToPolyline } from './terrain-contour-shaping.js'
import type { ComponentRecord } from './terrain-contour-grid.js'
import type { WorkingChain } from './terrain-contour-graph.js'
import type { WorkingRing } from './terrain-contour-rings.js'
import type { ContourCoordinate, TerrainContourUse } from './types.js'

const CURVE_BUCKET_SIZE_CELLS = 1
const TUBE_SAMPLE_SPACING_CELLS = 0.05

/** The chain fields the curve sweeps read, shared by working chains and planned ones. */
export interface CurveChainView {
  readonly id: string
  readonly closed: boolean
  readonly points: readonly ContourCoordinate[]
}

/** One drawn chord of one chain, closed rings including their seam chord. */
interface CurvePiece<Chain extends CurveChainView> {
  readonly chain: Chain
  readonly index: number
  readonly start: ContourCoordinate
  readonly end: ContourCoordinate
  readonly count: number
}

/** The drawn polyline of one chain, with the seam point repeated when closed. */
function closedPolyline(points: readonly ContourCoordinate[], closed: boolean) {
  return closed ? [...points, points[0]!] : points
}

function curvePieces<Chain extends CurveChainView>(
  chains: readonly Chain[],
): CurvePiece<Chain>[] {
  return chains.flatMap((chain) => {
    if (chain.points.length < 2) throw new Error('Terrain contour chain emitted too few points.')
    const points = closedPolyline(chain.points, chain.closed)
    return points.slice(0, -1).map((start, index) => ({
      chain,
      index,
      start,
      end: points[index + 1]!,
      count: points.length - 1,
    }))
  })
}

/** Every pair of drawn chords that truly cross, excluding shared endpoints and junctions. */
export function findCurveCrossings<Chain extends CurveChainView>(
  chains: readonly Chain[],
): readonly (readonly [CurvePiece<Chain>, CurvePiece<Chain>])[] {
  const found: [CurvePiece<Chain>, CurvePiece<Chain>][] = []
  for (const [first, second] of spatialCurvePairs(curvePieces(chains))) {
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
 * Where the reference turns a corner tighter than the displacement the curve spends there,
 * neighbouring samples move inward along converging normals, swap order along the boundary, and
 * the chords between them cross. Every crossing over the layout suite has that shape: two chords
 * two to six samples apart, about a tenth of a cell across. Clearance cannot catch it, since the
 * geometry it would have to see is the same curve a few samples along, which self-exclusion has
 * to ignore for any boundary to smooth at all. Repair it directly instead: pull the points of
 * every crossing piece halfway toward their reference positions and sweep again. The corner-cut
 * reference is planar, so the halving always converges without reintroducing staircase corners.
 */
const INTERSECTION_REPAIR_PASSES = 12

export function repairCurveGraph(chains: readonly WorkingChain[]): void {
  for (let pass = 0; pass < INTERSECTION_REPAIR_PASSES; pass += 1) {
    const offenders = findCurveCrossings(chains)
    if (offenders.length === 0) return
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
  }
}

/** The worst distance from a drawn curve to the reference polyline it was shaped from. */
export function maxCurveTubeDeviation(
  chains: readonly (CurveChainView & { readonly referencePoints: readonly ContourCoordinate[] })[],
): { readonly cells: number; readonly chainId: string; readonly at: ContourCoordinate } {
  let worst = { cells: 0, chainId: '', at: { x: 0, y: 0 } }
  for (const chain of chains) {
    const reference = indexRawPolyline(closedPolyline(chain.referencePoints, chain.closed))
    const points = closedPolyline(chain.points, chain.closed)
    for (const [index, start] of points.slice(0, -1).entries()) {
      const end = points[index + 1]!
      const steps = Math.max(1, Math.ceil(distance(start, end) / TUBE_SAMPLE_SPACING_CELLS))
      for (let step = 0; step <= steps; step += 1) {
        const amount = step / steps
        const at = {
          x: start.x + (end.x - start.x) * amount,
          y: start.y + (end.y - start.y) * amount,
        }
        const cells = projectToPolyline(at, reference).distance
        if (cells > worst.cells) worst = { cells, chainId: chain.id, at }
      }
    }
  }
  return worst
}

/** Return each pair of locally overlapping curve pieces once in deterministic insertion order. */
function spatialCurvePairs<Chain extends CurveChainView>(
  pieces: readonly CurvePiece<Chain>[],
): readonly (readonly [CurvePiece<Chain>, CurvePiece<Chain>])[] {
  const buckets = new Map<string, CurvePiece<Chain>[]>()
  const indexes = new Map(pieces.map((piece, index) => [piece, index]))
  const pairs: [CurvePiece<Chain>, CurvePiece<Chain>][] = []
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

function curveBucketKeys(piece: {
  readonly start: ContourCoordinate
  readonly end: ContourCoordinate
}): readonly string[] {
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

function piecesAreAdjacent(
  first: { readonly chain: CurveChainView; readonly index: number; readonly count: number },
  second: { readonly chain: CurveChainView; readonly index: number; readonly count: number },
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
    readonly chain: CurveChainView
    readonly start: ContourCoordinate
    readonly end: ContourCoordinate
  },
  second: {
    readonly chain: CurveChainView
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
