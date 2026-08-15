import { EPSILON, cellKey } from './terrain-helpers.js'
import { coordinateKey, samePoint } from './terrain-contour-graph.js'
import type { ComponentRecord } from './terrain-contour-grid.js'
import type { DirectedSegment, GraphNode, GraphSegment, SideRecord, WorkingChain } from './terrain-contour-graph.js'
import type { ContourCoordinate, TerrainContourUse } from './types.js'
/** A contour face while its ownership and nesting are assigned. */
export interface WorkingRing {
  id: string
  readonly componentKey: string
  componentId: string
  readonly material: string
  readonly rawPoints: readonly ContourCoordinate[]
  readonly uses: readonly TerrainContourUse[]
  readonly points: readonly ContourCoordinate[]
  readonly signedArea: number
  role: 'outer' | 'hole'
}
export function buildRings(
  nodes: readonly GraphNode[],
  segments: readonly GraphSegment[],
  chains: readonly WorkingChain[],
): WorkingRing[] {
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]))
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const placement = new Map<number, { chain: WorkingChain; reversed: boolean }>()
  for (const chain of chains) {
    for (const atom of chain.atoms) {
      if (placement.has(atom.segment.id))
        throw new Error('Terrain contour edge has duplicate chain ownership.')
      placement.set(atom.segment.id, { chain, reversed: atom.reversed })
    }
  }
  const visited = new Set<string>()
  const rings: WorkingRing[] = []
  const chainById = new Map(chains.map((chain) => [chain.id, chain]))
  for (const segment of segments) {
    for (const reversed of [false, true]) {
      const startKey = directedKey(segment.id, reversed)
      if (visited.has(startKey)) continue
      const darts: DirectedSegment[] = []
      let current: DirectedSegment = { segment, reversed }
      while (true) {
        const key = directedKey(current.segment.id, current.reversed)
        if (visited.has(key)) {
          if (key !== startKey)
            throw new Error('Terrain contour half-edge entered a different face cycle.')
          break
        }
        visited.add(key)
        darts.push(current)
        current = nextDirectedSegment(current, segmentById, nodeById)
      }
      const firstSide = directedLeft(darts[0]!)
      if (
        darts.some((dart) => {
          const side = directedLeft(dart)
          return (
            side.material !== firstSide.material || side.componentKey !== firstSide.componentKey
          )
        })
      ) {
        throw new Error('Terrain contour face cycle changes ownership.')
      }
      const rawUses = darts.map((dart) => {
        const owned = placement.get(dart.segment.id)
        if (owned === undefined) throw new Error('Terrain contour face references an unowned edge.')
        return { chainId: owned.chain.id, reversed: dart.reversed !== owned.reversed }
      })
      const uses = canonicalUses(compactCircularUses(rawUses))
      const rawPoints = pathForUses(uses, chainById, true)
      const points = pathForUses(uses, chainById, false)
      const rawArea = signedArea(rawPoints)
      rings.push({
        id: '',
        componentKey: firstSide.componentKey,
        componentId: '',
        material: firstSide.material,
        rawPoints,
        uses,
        points,
        signedArea: signedArea(points),
        role: rawArea >= 0 ? 'outer' : 'hole',
      })
    }
  }
  if (visited.size !== segments.length * 2)
    throw new Error('Terrain contour graph has open face ownership.')
  return rings
}

function rotate<T>(items: readonly T[], index: number): T[] {
  return [...items.slice(index), ...items.slice(0, index)]
}

function directedKey(segmentId: number, reversed: boolean): string {
  return `${segmentId}:${reversed ? 1 : 0}`
}

function directedEnd(directed: DirectedSegment): GraphNode {
  return directed.reversed ? directed.segment.start : directed.segment.end
}

function directedLeft(directed: DirectedSegment): SideRecord {
  return directed.reversed ? directed.segment.right : directed.segment.left
}

function nextDirectedSegment(
  directed: DirectedSegment,
  segmentById: ReadonlyMap<number, GraphSegment>,
  nodeById: ReadonlyMap<string, GraphNode>,
): DirectedSegment {
  const end = directedEnd(directed)
  const node = nodeById.get(end.id)
  if (node === undefined || node.segments.length < 2)
    throw new Error('Terrain contour face is open.')
  const outgoing = node.segments
    .map((segmentId) => {
      const segment = segmentById.get(segmentId)!
      const candidate: DirectedSegment = { segment, reversed: segment.end === node }
      const target = directedEnd(candidate)
      return { candidate, angle: Math.atan2(target.y - node.y, target.x - node.x) }
    })
    .sort(
      (first, second) =>
        first.angle - second.angle || first.candidate.segment.id - second.candidate.segment.id,
    )
  const reverseIndex = outgoing.findIndex(
    (item) => item.candidate.segment.id === directed.segment.id,
  )
  if (reverseIndex < 0) throw new Error('Terrain contour node lost its incoming half-edge.')
  return outgoing[(reverseIndex - 1 + outgoing.length) % outgoing.length]!.candidate
}

function compactCircularUses(uses: readonly TerrainContourUse[]): TerrainContourUse[] {
  const compact: TerrainContourUse[] = []
  for (const use of uses) {
    const previous = compact[compact.length - 1]
    if (previous?.chainId === use.chainId && previous.reversed === use.reversed) continue
    compact.push(use)
  }
  if (
    compact.length > 1 &&
    compact[0]!.chainId === compact[compact.length - 1]!.chainId &&
    compact[0]!.reversed === compact[compact.length - 1]!.reversed
  ) {
    compact.pop()
  }
  return compact
}

function canonicalUses(uses: readonly TerrainContourUse[]): TerrainContourUse[] {
  if (uses.length === 0) throw new Error('Terrain contour face has no shared chains.')
  let minimum = 0
  for (let index = 1; index < uses.length; index += 1) {
    const candidate = `${uses[index]!.chainId}:${uses[index]!.reversed ? 1 : 0}`
    const current = `${uses[minimum]!.chainId}:${uses[minimum]!.reversed ? 1 : 0}`
    if (candidate.localeCompare(current) < 0) minimum = index
  }
  return rotate(uses, minimum)
}

function pathForUses(
  uses: readonly TerrainContourUse[],
  chainById: ReadonlyMap<string, WorkingChain>,
  raw: boolean,
): ContourCoordinate[] {
  const result: ContourCoordinate[] = []
  for (const use of uses) {
    const chain = chainById.get(use.chainId)
    if (chain === undefined) throw new Error('Terrain contour ring references a missing chain.')
    let points: readonly ContourCoordinate[] = raw ? chain.rawPoints : chain.points
    if (use.reversed) points = [...points].reverse()
    for (const point of points) {
      if (result.length === 0 || !samePoint(result[result.length - 1]!, point))
        result.push({ x: point.x, y: point.y })
    }
  }
  if (!samePoint(result[0]!, result[result.length - 1]!)) result.push({ ...result[0]! })
  return result
}

function signedArea(points: readonly ContourCoordinate[]): number {
  let twiceArea = 0
  for (let index = 0; index < points.length - 1; index += 1) {
    const first = points[index]!
    const second = points[index + 1]!
    twiceArea += first.x * second.y - second.x * first.y
  }
  return twiceArea / 2
}

export function assignComponentAndRingIds(
  components: readonly ComponentRecord[],
  rings: WorkingRing[],
): void {
  components.forEach((component, index) => {
    component.id = `component-${index}`
  })
  const componentByKey = new Map(components.map((component) => [component.key, component]))
  rings.sort(
    (first, second) =>
      componentByKey
        .get(first.componentKey)!
        .id.localeCompare(componentByKey.get(second.componentKey)!.id) ||
      first.role.localeCompare(second.role) ||
      coordinateKey(first.rawPoints[0]!).localeCompare(coordinateKey(second.rawPoints[0]!)),
  )
  const ringsByComponent = new Map<string, WorkingRing[]>()
  rings.forEach((ring, index) => {
    ring.id = `ring-${index}`
    const component = componentByKey.get(ring.componentKey)
    if (component === undefined) throw new Error('Terrain contour ring has no component.')
    ring.componentId = component.id
    if (component.exterior) ring.role = 'outer'
    const owned = ringsByComponent.get(component.id) ?? []
    owned.push(ring)
    ringsByComponent.set(component.id, owned)
  })
  for (const component of components) {
    const owned = ringsByComponent.get(component.id) ?? []
    const outers = owned.filter((ring) => ring.role === 'outer')
    if (outers.length !== 1) {
      throw new Error(`Terrain contour component ${component.id} needs exactly one outer ring.`)
    }
    component.outerRingId = outers[0]!.id
    component.holeRingIds = owned.filter((ring) => ring.role === 'hole').map((ring) => ring.id)
  }
}

export function assignComponentNesting(
  components: readonly ComponentRecord[],
  rings: readonly WorkingRing[],
): void {
  const ringById = new Map(rings.map((ring) => [ring.id, ring]))
  const candidatesByCell = outerRingCandidatesByCell(components, ringById)
  for (const component of components) {
    if (component.exterior || component.cells.length === 0) continue
    const sample = component.cells[0]!
    const ownOuter = ringById.get(component.outerRingId)!
    const containers = (candidatesByCell.get(cellKey(sample.column, sample.row)) ?? [])
      .filter((candidate) => candidate !== component)
      .map((candidate) => ({ candidate, ring: ringById.get(candidate.outerRingId)! }))
      .filter(
        ({ ring }) =>
          Math.abs(signedArea(ring.rawPoints)) > Math.abs(signedArea(ownOuter.rawPoints)) + EPSILON,
      )
      .filter(({ ring }) => pointInPolygon(sample, ring.rawPoints))
      .sort(
        (first, second) =>
          Math.abs(signedArea(first.ring.rawPoints)) -
            Math.abs(signedArea(second.ring.rawPoints)) ||
          first.candidate.id.localeCompare(second.candidate.id),
      )
    component.parentComponentId = containers[0]?.candidate.id
  }
  const byId = new Map(components.map((component) => [component.id, component]))
  const depthFor = (component: ComponentRecord, seen = new Set<string>()): number => {
    if (component.parentComponentId === undefined) return 0
    if (seen.has(component.id))
      throw new Error('Terrain contour component nesting contains a cycle.')
    seen.add(component.id)
    const parent = byId.get(component.parentComponentId)
    if (parent === undefined)
      throw new Error('Terrain contour component has a missing nesting parent.')
    return 1 + depthFor(parent, seen)
  }
  for (const component of components) component.nestingDepth = depthFor(component)
}

/** Index candidate outer-ring bounds by the semantic cell centers they can contain. */
function outerRingCandidatesByCell(
  components: readonly ComponentRecord[],
  ringById: ReadonlyMap<string, WorkingRing>,
): ReadonlyMap<string, readonly ComponentRecord[]> {
  const candidates = new Map<string, ComponentRecord[]>()
  for (const component of components) {
    if (component.exterior || component.cells.length === 0) continue
    const ring = ringById.get(component.outerRingId)
    if (ring === undefined) throw new Error('Terrain contour component has a missing outer ring.')
    const bounds = ringBounds(ring.rawPoints)
    for (let row = Math.floor(bounds.minimumY); row <= Math.floor(bounds.maximumY); row += 1) {
      for (
        let column = Math.floor(bounds.minimumX);
        column <= Math.floor(bounds.maximumX);
        column += 1
      ) {
        const key = cellKey(column, row)
        const bucket = candidates.get(key) ?? []
        bucket.push(component)
        candidates.set(key, bucket)
      }
    }
  }
  return candidates
}

function ringBounds(points: readonly ContourCoordinate[]): {
  minimumX: number
  maximumX: number
  minimumY: number
  maximumY: number
} {
  return points.reduce(
    (bounds, point) => ({
      minimumX: Math.min(bounds.minimumX, point.x),
      maximumX: Math.max(bounds.maximumX, point.x),
      minimumY: Math.min(bounds.minimumY, point.y),
      maximumY: Math.max(bounds.maximumY, point.y),
    }),
    {
      minimumX: Number.POSITIVE_INFINITY,
      maximumX: Number.NEGATIVE_INFINITY,
      minimumY: Number.POSITIVE_INFINITY,
      maximumY: Number.NEGATIVE_INFINITY,
    },
  )
}

function pointInPolygon(point: ContourCoordinate, polygon: readonly ContourCoordinate[]): boolean {
  let inside = false
  for (
    let firstIndex = 0, secondIndex = polygon.length - 1;
    firstIndex < polygon.length;
    secondIndex = firstIndex++
  ) {
    const first = polygon[firstIndex]!
    const second = polygon[secondIndex]!
    const crosses =
      first.y > point.y !== second.y > point.y &&
      point.x < ((second.x - first.x) * (point.y - first.y)) / (second.y - first.y) + first.x
    if (crosses) inside = !inside
  }
  return inside
}
