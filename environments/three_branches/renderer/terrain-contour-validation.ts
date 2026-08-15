import { distance } from '@renderers/base/math.js'

import { EPSILON, cellKey, projectToSegment } from './terrain-helpers.js'
import { samePoint } from './terrain-contour-graph.js'
import { indexRawPolyline, projectToPolyline, rawPointAt } from './terrain-contour-shaping.js'
import type { ComponentRecord } from './terrain-contour-grid.js'
import type { WorkingChain } from './terrain-contour-graph.js'
import type { WorkingRing } from './terrain-contour-rings.js'
import type { ContourCoordinate, TerrainContourPoint, TerrainContourUse } from './types.js'
import type { RawPolylineIndex } from './terrain-contour-shaping.js'
const CURVE_BUCKET_SIZE_CELLS = 1

interface CurvePiece {
  readonly chain: WorkingChain
  readonly rawIndex: RawPolylineIndex
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

/** Emitted-curve pieces, closed rings including their seam chord, for sweeps and repair. */
function curvePieces(chains: readonly WorkingChain[]): CurvePiece[] {
  return chains.flatMap((chain) => {
    if (chain.points.length < 2) throw new Error('Terrain contour chain emitted too few points.')
    const points = chain.closed ? [...chain.points, chain.points[0]!] : chain.points
    const rawIndex = indexRawPolyline(chain.rawPoints)
    return points.slice(0, -1).map((start, index) => ({
      chain,
      rawIndex,
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
 * envelope can tell those stretches from an ordinary staircase. Repair directly instead: pull
 * the points of every crossing piece halfway toward their raw positions and sweep again. Raw
 * geometry is planar, so the halving always converges.
 */
const INTERSECTION_REPAIR_PASSES = 12

export function repairContourIntersections(chains: readonly WorkingChain[]): void {
  for (let pass = 0; pass < INTERSECTION_REPAIR_PASSES; pass += 1) {
    const offenders = nonincidentIntersections(curvePieces(chains))
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
        const raw = rawPointAt(
          point.rawOffset,
          chain.rawPoints,
          chain.spans,
          chain.rawLength,
          chain.closed,
        )
        points[index] = {
          ...point,
          x: raw.x + (point.x - raw.x) * 0.5,
          y: raw.y + (point.y - raw.y) * 0.5,
        }
      }
      chain.points = points
    }
  }
}

export function validateCurveGraph(chains: readonly WorkingChain[], maxDeviation: number): void {
  const pieces = curvePieces(chains)
  const allowed = maxDeviation + VALIDATION_SAG_CELLS
  for (const piece of pieces) {
    if (!segmentStaysInTube(piece.start, piece.end, piece.rawIndex, allowed)) {
      const worst = worstChordDistance(piece.start, piece.end, piece.rawIndex)
      throw new Error(
        `Terrain contour curve escaped its source tube: chain ${piece.chain.id} ` +
          `(${piece.chain.leftMaterial} against ${piece.chain.rightMaterial}) near ` +
          `(${piece.start.x.toFixed(2)}, ${piece.start.y.toFixed(2)}) deviates ` +
          `${worst.toFixed(3)} of ${allowed.toFixed(3)} allowed cells.`,
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

/** Densely sampled worst chord deviation, reported when the tube validation fails. */
function worstChordDistance(
  start: ContourCoordinate,
  end: ContourCoordinate,
  rawIndex: RawPolylineIndex,
): number {
  let worst = 0
  for (let step = 0; step <= 16; step += 1) {
    const amount = step / 16
    const point = {
      x: start.x + (end.x - start.x) * amount,
      y: start.y + (end.y - start.y) * amount,
    }
    worst = Math.max(worst, projectToPolyline(point, rawIndex).distance)
  }
  return worst
}

/** Prove the full emitted segment stays in the source tube through adaptive 1-Lipschitz bounds. */
function segmentStaysInTube(
  start: ContourCoordinate,
  end: ContourCoordinate,
  rawIndex: RawPolylineIndex,
  maxDeviation: number,
  depth = 0,
): boolean {
  const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
  const maximumDistance = Math.max(
    projectToPolyline(start, rawIndex).distance,
    projectToPolyline(middle, rawIndex).distance,
    projectToPolyline(end, rawIndex).distance,
  )
  const quarterLength = distance(start, end) / 4
  if (maximumDistance + quarterLength <= maxDeviation + 1e-7) return true
  if (depth >= 18) return maximumDistance <= maxDeviation + 1e-7
  return (
    segmentStaysInTube(start, middle, rawIndex, maxDeviation, depth + 1) &&
    segmentStaysInTube(middle, end, rawIndex, maxDeviation, depth + 1)
  )
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
