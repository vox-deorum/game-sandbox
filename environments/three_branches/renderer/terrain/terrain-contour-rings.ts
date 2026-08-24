import type { ContourCoordinate, TerrainContourUse } from '../core/types.js'
import type {
  DirectedSegment,
  GraphNode,
  GraphSegment,
  SideRecord,
  WorkingChain,
} from './terrain-contour-graph.js'
import { coordinateKey, samePoint } from './terrain-contour-graph.js'
import type { ComponentRecord } from './terrain-contour-grid.js'
import { rotate } from './terrain-helpers.js'
/** A contour face while its ownership is assigned. */
export interface WorkingRing {
  id: string
  readonly componentKey: string
  componentId: string
  readonly material: string
  readonly rawPoints: readonly ContourCoordinate[]
  readonly uses: readonly TerrainContourUse[]
  readonly points: readonly ContourCoordinate[]
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
      placement.set(atom.segment.id, { chain, reversed: atom.reversed })
    }
  }
  const visited = new Set<string>()
  const rings: WorkingRing[] = []
  const chainById = new Map(chains.map((chain) => [chain.id, chain]))
  for (const segment of segments) {
    for (const reversed of [false, true]) {
      if (visited.has(directedKey(segment.id, reversed))) continue
      const darts: DirectedSegment[] = []
      let current: DirectedSegment = { segment, reversed }
      while (true) {
        const key = directedKey(current.segment.id, current.reversed)
        if (visited.has(key)) break
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
        role: rawArea >= 0 ? 'outer' : 'hole',
      })
    }
  }
  return rings
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
