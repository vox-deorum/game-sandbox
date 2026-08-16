import { distance } from '@renderers/base/math.js'

import { FIXED_MATERIALS, TERRAIN_EXTERIOR } from './terrain-contour-grid.js'
import { cellAt, compareCells, EPSILON, required } from './terrain-helpers.js'
import type {
  ContourCoordinate,
  ContourReference,
  TerrainContourPoint,
  TerrainContourSide,
  TerrainContourSpan,
  TerrainShorelineSpan,
  TerrainContourUse,
} from './types.js'
import type { CellRecord } from './terrain-contour-grid.js'
/** A shared contour-graph vertex. */
export interface GraphNode extends ContourCoordinate {
  readonly id: string
  readonly segments: number[]
}

/** An oriented source boundary between two contour sides. */
export interface GraphSegment {
  readonly id: number
  readonly start: GraphNode
  readonly end: GraphNode
  readonly fixed: boolean
  left: SideRecord
  right: SideRecord
}

/** Material and component provenance on one side of a graph segment. */
export interface SideRecord extends TerrainContourSide {
  readonly componentKey: string
}

/** One graph segment in a canonical chain direction. */
export interface ChainAtom {
  readonly segment: GraphSegment
  readonly reversed: boolean
}

/** A shared contour boundary with mutable emitted curve points. */
export interface WorkingChain {
  id: string
  readonly closed: boolean
  readonly pairKey: string
  readonly atoms: readonly ChainAtom[]
  readonly rawPoints: readonly ContourCoordinate[]
  readonly rawLength: number
  readonly spans: readonly TerrainContourSpan[]
  reference?: ContourReference
  points: readonly TerrainContourPoint[]
  readonly materials: readonly [string, string]
  readonly leftMaterial: string
  readonly rightMaterial: string
  readonly componentKeys: readonly [string, string]
  readonly shorelineSpans: readonly TerrainShorelineSpan[]
}

/** A graph segment traversed in one direction while walking a ring. */
export interface DirectedSegment {
  readonly segment: GraphSegment
  readonly reversed: boolean
}

export function buildGraph(
  cells: readonly CellRecord[],
  width: number,
  height: number,
  componentKeyForCell: ReadonlyMap<number, string>,
): { nodes: readonly GraphNode[]; segments: readonly GraphSegment[] } {
  const nodes = new Map<string, GraphNode>()
  const segments: GraphSegment[] = []

  const node = (x: number, y: number): GraphNode => {
    const id = `v:${x}:${y}`
    const existing = nodes.get(id)
    if (existing !== undefined) return existing
    const created = { id, x, y, segments: [] }
    nodes.set(id, created)
    return created
  }
  const addSegment = (
    start: GraphNode,
    end: GraphNode,
    leftCells: readonly CellRecord[],
    rightCells: readonly CellRecord[],
  ): void => {
    if (samePoint(start, end))
      throw new Error('Terrain contour contains a zero-length source edge.')
    const left = sideFromCells(leftCells, componentKeyForCell)
    const right = sideFromCells(rightCells, componentKeyForCell)
    if (left.material === right.material) {
      throw new Error('Terrain contour source edge does not separate two materials.')
    }
    const fixed =
      FIXED_MATERIALS.has(left.material) ||
      FIXED_MATERIALS.has(right.material) ||
      left.semantics.includes('bridge') ||
      right.semantics.includes('bridge')
    const segment = { id: segments.length, start, end, fixed, left, right }
    segments.push(segment)
    start.segments.push(segment.id)
    end.segments.push(segment.id)
  }

  for (let y = 0; y <= height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const north = cellAt(cells, width, height, x, y - 1)
      const south = cellAt(cells, width, height, x, y)
      if ((north?.material ?? TERRAIN_EXTERIOR) !== (south?.material ?? TERRAIN_EXTERIOR)) {
        addSegment(
          node(x, y),
          node(x + 1, y),
          south === undefined ? [] : [south],
          north === undefined ? [] : [north],
        )
      }
    }
  }
  for (let x = 0; x <= width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      const west = cellAt(cells, width, height, x - 1, y)
      const east = cellAt(cells, width, height, x, y)
      if ((west?.material ?? TERRAIN_EXTERIOR) !== (east?.material ?? TERRAIN_EXTERIOR)) {
        addSegment(
          node(x, y),
          node(x, y + 1),
          west === undefined ? [] : [west],
          east === undefined ? [] : [east],
        )
      }
    }
  }

  return {
    nodes: [...nodes.values()].sort((first, second) => first.id.localeCompare(second.id)),
    segments,
  }
}

function sideFromCells(
  cells: readonly CellRecord[],
  componentKeyForCell: ReadonlyMap<number, string>,
): SideRecord {
  const first = cells[0]
  if (first === undefined) {
    return {
      material: TERRAIN_EXTERIOR,
      semantics: [TERRAIN_EXTERIOR],
      cells: [],
      componentKey: TERRAIN_EXTERIOR,
    }
  }
  const componentKey = componentKeyForCell.get(first.index)
  if (componentKey === undefined) throw new Error('Terrain contour source cell has no component.')
  if (
    cells.some(
      (cell) =>
        cell.material !== first.material || componentKeyForCell.get(cell.index) !== componentKey,
    )
  ) {
    throw new Error('Terrain contour side crosses material components.')
  }
  return {
    material: first.material,
    semantics: [...new Set(cells.map((cell) => cell.semantic))].sort(),
    cells: [...cells].sort(compareCells),
    componentKey,
  }
}

export function samePoint(first: ContourCoordinate, second: ContourCoordinate): boolean {
  return Math.abs(first.x - second.x) <= EPSILON && Math.abs(first.y - second.y) <= EPSILON
}

function segmentPair(segment: GraphSegment): readonly [string, string] {
  return [segment.left.material, segment.right.material].sort() as [string, string]
}

function pairKey(segment: GraphSegment): string {
  return segmentPair(segment).join('\u0000')
}

export function buildChains(
  nodes: readonly GraphNode[],
  segments: readonly GraphSegment[],
): WorkingChain[] {
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]))
  const visited = new Set<number>()
  const sourceChains: Array<{
    readonly closed: boolean
    readonly pairKey: string
    readonly atoms: readonly ChainAtom[]
  }> = []

  const continues = (node: GraphNode, key: string): boolean =>
    node.segments.length === 2 &&
    node.segments.every((segmentId) => pairKey(segmentById.get(segmentId)!) === key)

  for (const seed of segments) {
    if (visited.has(seed.id)) continue
    const key = pairKey(seed)
    // Walk back to where this run begins before walking it. A seed that lands mid-run would
    // otherwise leave everything behind it for a later seed to claim as a chain of its own, and
    // since both ends of a chain are locked, each of those cuts freezes the curve onto a raw cell
    // corner. Edges are added row by row, so a boundary running at an angle is seeded on nearly
    // every row, and cutting it there is what leaves a drawn boundary stepping. On a closed loop
    // the walk comes back to the seed and any node of the loop serves as its start.
    let segment = seed
    let node = seed.start
    while (continues(node, key)) {
      const behindId = node.segments.find((segmentId) => segmentId !== segment.id)
      if (behindId === undefined) {
        throw new Error('Terrain contour chain ended at a degree-two node.')
      }
      const behind = required(segmentById.get(behindId), 'Terrain contour segment is missing.')
      if (behind.id === seed.id) break
      segment = behind
      node = behind.end === node ? behind.start : behind.end
    }
    const start = node
    const atoms: ChainAtom[] = []
    let closed = false
    while (true) {
      if (visited.has(segment.id)) {
        if (node === start) closed = true
        break
      }
      visited.add(segment.id)
      const reversed = segment.end === node
      atoms.push({ segment, reversed })
      node = reversed ? segment.start : segment.end
      if (!continues(node, key)) break
      const nextId = node.segments.find((segmentId) => segmentId !== segment.id)
      if (nextId === undefined) throw new Error('Terrain contour chain ended at a degree-two node.')
      segment = segmentById.get(nextId)!
    }
    sourceChains.push({ closed, pairKey: key, atoms: canonicalAtoms(atoms, closed) })
  }
  if (visited.size !== segments.length)
    throw new Error('Terrain contour chain ownership is incomplete.')

  const ordered = sourceChains.sort(
    (first, second) =>
      first.pairKey.localeCompare(second.pairKey) ||
      atomSequenceKey(first.atoms, first.closed).localeCompare(
        atomSequenceKey(second.atoms, second.closed),
      ),
  )
  return ordered.map((source, index) => finishChain(source, `chain-${index}`))
}

function canonicalAtoms(atoms: readonly ChainAtom[], closed: boolean): readonly ChainAtom[] {
  if (atoms.length === 0) throw new Error('Terrain contour chain has no source edges.')
  if (!closed) {
    const first = atomStart(atoms[0]!)
    const last = atomEnd(atoms[atoms.length - 1]!)
    return compareCoordinates(first, last) <= 0 ? atoms : reverseAtoms(atoms)
  }
  let minimum = 0
  for (let index = 1; index < atoms.length; index += 1) {
    if (compareCoordinates(atomStart(atoms[index]!), atomStart(atoms[minimum]!)) < 0)
      minimum = index
  }
  const forward = rotate(atoms, minimum)
  const reversed = reverseAtoms(forward)
  const reversedMinimum = reversed.findIndex((atom) =>
    samePoint(atomStart(atom), atomStart(forward[0]!)),
  )
  const rotatedReverse = rotate(reversed, reversedMinimum)
  return atomSequenceKey(forward, true).localeCompare(atomSequenceKey(rotatedReverse, true)) <= 0
    ? forward
    : rotatedReverse
}

function atomStart(atom: ChainAtom): GraphNode {
  return atom.reversed ? atom.segment.end : atom.segment.start
}

function atomEnd(atom: ChainAtom): GraphNode {
  return atom.reversed ? atom.segment.start : atom.segment.end
}

function reverseAtoms(atoms: readonly ChainAtom[]): ChainAtom[] {
  return [...atoms].reverse().map((atom) => ({ segment: atom.segment, reversed: !atom.reversed }))
}

function rotate<T>(items: readonly T[], index: number): T[] {
  return [...items.slice(index), ...items.slice(0, index)]
}

function compareCoordinates(first: ContourCoordinate, second: ContourCoordinate): number {
  return first.y - second.y || first.x - second.x
}

export function coordinateKey(point: ContourCoordinate): string {
  return `${point.y.toFixed(9)}:${point.x.toFixed(9)}`
}

function atomSequenceKey(atoms: readonly ChainAtom[], closed: boolean): string {
  const points = atoms.map(atomStart)
  if (!closed) points.push(atomEnd(atoms[atoms.length - 1]!))
  return points.map(coordinateKey).join('|')
}

function finishChain(
  source: {
    readonly closed: boolean
    readonly pairKey: string
    readonly atoms: readonly ChainAtom[]
  },
  id: string,
): WorkingChain {
  const rawPoints: ContourCoordinate[] = [atomStart(source.atoms[0]!)]
  const spans: TerrainContourSpan[] = []
  let rawLength = 0
  for (const atom of source.atoms) {
    const start = atomStart(atom)
    const end = atomEnd(atom)
    if (!samePoint(rawPoints[rawPoints.length - 1]!, start)) {
      throw new Error('Terrain contour chain source edges are not continuous.')
    }
    const length = distance(start, end)
    const left = atom.reversed ? atom.segment.right : atom.segment.left
    const right = atom.reversed ? atom.segment.left : atom.segment.right
    const shoreline =
      (left.material === 'water' || right.material === 'water') &&
      left.material !== TERRAIN_EXTERIOR &&
      right.material !== TERRAIN_EXTERIOR
    const water = left.material === 'water' ? left : right.material === 'water' ? right : undefined
    spans.push({
      startOffset: rawLength,
      endOffset: rawLength + length,
      left,
      right,
      fixed: atom.segment.fixed,
      shoreline,
      bridgeSuppressed: shoreline && (water?.semantics.includes('bridge') ?? false),
    })
    rawLength += length
    rawPoints.push(end)
  }
  const firstSpan = spans[0]!
  if (
    spans.some(
      (span) =>
        span.left.material !== firstSpan.left.material ||
        span.right.material !== firstSpan.right.material,
    )
  ) {
    throw new Error('Terrain contour chain changes its incident material order.')
  }
  const materials = source.pairKey.split('\u0000') as [string, string]
  const shorelineSpans = spans
    .filter((span) => span.shoreline)
    .map((span) => {
      const water = span.left.material === 'water' ? span.left : span.right
      return {
        startOffset: span.startOffset,
        endOffset: span.endOffset,
        waterSemantics: water.semantics,
        suppressed: span.bridgeSuppressed,
      }
    })
  return {
    id,
    closed: source.closed,
    pairKey: source.pairKey,
    atoms: source.atoms,
    rawPoints,
    rawLength,
    spans,
    points: [],
    materials,
    leftMaterial: firstSpan.left.material,
    rightMaterial: firstSpan.right.material,
    componentKeys: [
      (firstSpan.left as SideRecord).componentKey,
      (firstSpan.right as SideRecord).componentKey,
    ],
    shorelineSpans,
  }
}
