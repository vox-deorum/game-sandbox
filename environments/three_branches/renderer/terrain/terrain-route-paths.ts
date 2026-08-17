import { stableHashParts } from '@renderers/base/math.js'
import type {
  TerrainBridgeComponent,
  TerrainPathConnector,
  TerrainPathGuide,
  TerrainPathGuidePoint,
  TerrainRoadGuidePoint,
  TerrainRouteCell,
  TerrainRoutePoint,
  TerrainRouteSettings,
} from '../core/types.js'
import { shapeTerrainCurve } from './terrain-curves.js'
import { cellAt, cellKey, compareCells, EPSILON, required } from './terrain-helpers.js'
import type { CellRecord } from './terrain-route-grid.js'
import { CARDINAL_DIRECTIONS, cellCoordinate } from './terrain-route-grid.js'
import { closestPointOnGuide, roadMaskWidthAt, sourceAtOffset } from './terrain-route-road.js'

interface PathGraphNode {
  readonly id: string
  readonly point: TerrainRoutePoint
  readonly cell?: TerrainRouteCell
  readonly bridge: boolean
  readonly roadContact: boolean
  readonly neighbors: Set<string>
}

interface PathRoadContact {
  readonly path: CellRecord
  readonly road: CellRecord
  readonly tangent: TerrainRoutePoint
  readonly contact: TerrainRoutePoint
  readonly continuity: number
  readonly absorbedPathCells: readonly TerrainRouteCell[]
}

/** Build path-to-road connector segments from terminal route contacts. */
export function buildPathConnectors(
  cells: readonly CellRecord[],
  width: number,
  height: number,
  roadMaskCells: readonly TerrainRouteCell[],
  guide: readonly TerrainRoadGuidePoint[],
  widthCells: number,
): readonly TerrainPathConnector[] {
  if (guide.length === 0) return []
  const roadMask = new Set(roadMaskCells.map((cell) => cellKey(cell.column, cell.row)))
  const contacts: PathRoadContact[] = []
  for (const path of cells) {
    if (path.material !== 'path') continue
    const roads: CellRecord[] = []
    for (const [dx, dy] of CARDINAL_DIRECTIONS) {
      const road = cellAt(cells, width, height, path.column + dx, path.row + dy)
      if (road === undefined || !roadMask.has(cellKey(road.column, road.row))) continue
      roads.push(road)
    }
    if (roads.length === 0) continue
    const start = { x: path.column + 0.5, y: path.row + 0.5 }
    const tangent = pathTerminalTangent(path, roads, cells, width, height)
    const contact =
      forwardGuideIntersection(start, tangent, guide) ??
      closestPointOnGuideAlongTangent(start, tangent, guide)
    const road = [...roads].sort((first, second) => {
      const firstProjection =
        (first.column + 0.5 - start.x) * tangent.x + (first.row + 0.5 - start.y) * tangent.y
      const secondProjection =
        (second.column + 0.5 - start.x) * tangent.x + (second.row + 0.5 - start.y) * tangent.y
      return secondProjection - firstProjection || compareCells(first, second)
    })[0]
    if (road !== undefined) {
      contacts.push({
        path,
        road,
        tangent,
        contact,
        continuity: pathContinuationAlignment(path, tangent, cells, width, height),
        absorbedPathCells: [],
      })
    }
  }
  contacts.sort(
    (first, second) =>
      compareCells(first.path, second.path) || compareCells(first.road, second.road),
  )
  const collapsedContacts = collapsePathContacts(contacts, cells, width, height)
  const paired = new Set<number>()
  const connectors: Array<Omit<TerrainPathConnector, 'id'>> = []
  for (let contactIndex = 0; contactIndex < collapsedContacts.length; contactIndex += 1) {
    if (paired.has(contactIndex)) continue
    const current = required(collapsedContacts[contactIndex], 'Path contact is missing.')
    const oppositeIndex = collapsedContacts.findIndex(
      (candidate, candidateIndex) =>
        candidateIndex > contactIndex &&
        !paired.has(candidateIndex) &&
        opposingPathTerminals(current, candidate, widthCells),
    )
    if (oppositeIndex >= 0) {
      const opposite = required(
        collapsedContacts[oppositeIndex],
        'Opposite path contact is missing.',
      )
      paired.add(contactIndex)
      paired.add(oppositeIndex)
      connectors.push({
        pathCell: cellCoordinate(current.path),
        oppositePathCell: cellCoordinate(opposite.path),
        roadCell: cellCoordinate(current.road),
        start: { x: current.path.column + 0.5, y: current.path.row + 0.5 },
        end: { x: opposite.path.column + 0.5, y: opposite.path.row + 0.5 },
        via: uniquePoints([current.contact, opposite.contact]),
        absorbedPathCells: [...current.absorbedPathCells, ...opposite.absorbedPathCells].sort(
          compareCells,
        ),
        widthCells,
      })
      continue
    }
    paired.add(contactIndex)
    const { path, road, tangent, contact } = current
    const start = { x: path.column + 0.5, y: path.row + 0.5 }
    const localRoadWidth = roadMaskWidthAt(contact, guide)
    const overlap = Math.max(widthCells / 2, localRoadWidth / 2 - widthCells / 2)
    const end = {
      x: contact.x + tangent.x * overlap,
      y: contact.y + tangent.y * overlap,
    }
    connectors.push({
      pathCell: cellCoordinate(path),
      roadCell: cellCoordinate(road),
      start,
      end,
      absorbedPathCells: current.absorbedPathCells,
      widthCells,
    })
  }
  return connectors.map((connector, index) => ({ id: `path-connector-${index}`, ...connector }))
}

function opposingPathTerminals(
  first: PathRoadContact,
  second: PathRoadContact,
  pathWidthCells: number,
): boolean {
  const firstStart = { x: first.path.column + 0.5, y: first.path.row + 0.5 }
  const secondStart = { x: second.path.column + 0.5, y: second.path.row + 0.5 }
  const between = { x: secondStart.x - firstStart.x, y: secondStart.y - firstStart.y }
  const distance = Math.hypot(between.x, between.y)
  if (distance <= EPSILON) return false
  const direction = { x: between.x / distance, y: between.y / distance }
  if (
    direction.x * first.tangent.x + direction.y * first.tangent.y < 0.8 ||
    direction.x * second.tangent.x + direction.y * second.tangent.y > -0.8 ||
    first.tangent.x * second.tangent.x + first.tangent.y * second.tangent.y > -0.8
  ) {
    return false
  }
  if (Math.abs(cross(between, first.tangent)) > 1 + pathWidthCells / 4 + EPSILON) return false
  const firstContactDistance =
    (first.contact.x - firstStart.x) * first.tangent.x +
    (first.contact.y - firstStart.y) * first.tangent.y
  const secondContactDistance =
    (second.contact.x - secondStart.x) * second.tangent.x +
    (second.contact.y - secondStart.y) * second.tangent.y
  return (
    firstContactDistance >= -EPSILON &&
    secondContactDistance >= -EPSILON &&
    firstContactDistance <= distance + EPSILON &&
    secondContactDistance <= distance + EPSILON
  )
}

function collapsePathContacts(
  contacts: readonly PathRoadContact[],
  cells: readonly CellRecord[],
  width: number,
  height: number,
): readonly PathRoadContact[] {
  const contactForCell = new Map(
    contacts.map((contact, index) => [cellKey(contact.path.column, contact.path.row), index]),
  )
  const visited = new Set<number>()
  const result: PathRoadContact[] = []
  for (let startIndex = 0; startIndex < contacts.length; startIndex += 1) {
    if (visited.has(startIndex)) continue
    const group: PathRoadContact[] = []
    const pending = [startIndex]
    visited.add(startIndex)
    while (pending.length > 0) {
      const index = required(pending.shift(), 'Path contact queue is empty.')
      const contact = required(contacts[index], 'Path contact group member is missing.')
      group.push(contact)
      for (const [dx, dy] of CARDINAL_DIRECTIONS) {
        const neighborIndex = contactForCell.get(
          cellKey(contact.path.column + dx, contact.path.row + dy),
        )
        if (neighborIndex === undefined || visited.has(neighborIndex)) continue
        const neighbor = required(contacts[neighborIndex], 'Neighboring path contact is missing.')
        if (contact.tangent.x * neighbor.tangent.x + contact.tangent.y * neighbor.tangent.y < 0.8) {
          continue
        }
        visited.add(neighborIndex)
        pending.push(neighborIndex)
      }
    }
    const winner = required(
      [...group].sort(
        (first, second) =>
          second.continuity - first.continuity || compareCells(first.path, second.path),
      )[0],
      'Path contact group has no winner.',
    )
    const groupKeys = new Set(
      group.map((contact) => cellKey(contact.path.column, contact.path.row)),
    )
    const absorbedPathCells = group
      .filter((contact) => contact !== winner)
      .filter((contact) =>
        CARDINAL_DIRECTIONS.map(([dx, dy]) =>
          cellAt(cells, width, height, contact.path.column + dx, contact.path.row + dy),
        )
          .filter((cell): cell is CellRecord => cell?.material === 'path')
          .every((cell) => groupKeys.has(cellKey(cell.column, cell.row))),
      )
      .map((contact) => cellCoordinate(contact.path))
      .sort(compareCells)
    result.push({ ...winner, absorbedPathCells })
  }
  return result.sort(
    (first, second) =>
      compareCells(first.path, second.path) || compareCells(first.road, second.road),
  )
}

function pathContinuationAlignment(
  path: CellRecord,
  tangent: TerrainRoutePoint,
  cells: readonly CellRecord[],
  width: number,
  height: number,
): number {
  return Math.max(
    -1,
    ...incomingPathTangents(path, cells, width, height).map(
      ({ tangent: incoming }) => incoming.x * tangent.x + incoming.y * tangent.y,
    ),
  )
}

function uniquePoints(points: readonly TerrainRoutePoint[]): readonly TerrainRoutePoint[] {
  const result: TerrainRoutePoint[] = []
  for (const point of points) {
    const previous = result.at(-1)
    if (
      previous === undefined ||
      Math.abs(previous.x - point.x) > EPSILON ||
      Math.abs(previous.y - point.y) > EPSILON
    ) {
      result.push(point)
    }
  }
  return result
}

function pathTerminalTangent(
  path: CellRecord,
  roads: readonly CellRecord[],
  cells: readonly CellRecord[],
  width: number,
  height: number,
): TerrainRoutePoint {
  const start = { x: path.column + 0.5, y: path.row + 0.5 }
  const roadVector = roads.reduce(
    (sum, road) => ({
      x: sum.x + road.column + 0.5 - start.x,
      y: sum.y + road.row + 0.5 - start.y,
    }),
    { x: 0, y: 0 },
  )
  const roadDirection =
    Math.hypot(roadVector.x, roadVector.y) <= EPSILON ? undefined : normalizedVector(roadVector)
  const incoming = incomingPathTangents(path, cells, width, height).sort((first, second) => {
    if (roadDirection === undefined) return compareCells(first.cell, second.cell)
    return (
      second.tangent.x * roadDirection.x +
        second.tangent.y * roadDirection.y -
        (first.tangent.x * roadDirection.x + first.tangent.y * roadDirection.y) ||
      compareCells(first.cell, second.cell)
    )
  })
  const best = incoming[0]
  if (roadDirection === undefined && best !== undefined) return best.tangent
  if (
    best !== undefined &&
    roadDirection !== undefined &&
    best.tangent.x * roadDirection.x + best.tangent.y * roadDirection.y > EPSILON
  ) {
    return best.tangent
  }
  return roadDirection ?? best?.tangent ?? { x: 1, y: 0 }
}

function incomingPathTangents(
  path: CellRecord,
  cells: readonly CellRecord[],
  width: number,
  height: number,
): Array<{ readonly cell: CellRecord; readonly tangent: TerrainRoutePoint }> {
  return CARDINAL_DIRECTIONS.map(([dx, dy]) =>
    cellAt(cells, width, height, path.column + dx, path.row + dy),
  )
    .filter((cell): cell is CellRecord => cell?.material === 'path')
    .map((cell) => ({
      cell,
      tangent: normalizedVector({ x: path.column - cell.column, y: path.row - cell.row }),
    }))
}

function normalizedVector(vector: TerrainRoutePoint): TerrainRoutePoint {
  const length = Math.hypot(vector.x, vector.y)
  return length <= EPSILON ? { x: 1, y: 0 } : { x: vector.x / length, y: vector.y / length }
}

function forwardGuideIntersection(
  start: TerrainRoutePoint,
  tangent: TerrainRoutePoint,
  guide: readonly TerrainRoadGuidePoint[],
): TerrainRoutePoint | undefined {
  let nearest: { point: TerrainRoutePoint; distance: number } | undefined
  for (let index = 1; index < guide.length; index += 1) {
    const segmentStart = guide[index - 1]
    const segmentEnd = guide[index]
    if (segmentStart === undefined || segmentEnd === undefined) continue
    const segment = { x: segmentEnd.x - segmentStart.x, y: segmentEnd.y - segmentStart.y }
    const denominator = cross(tangent, segment)
    if (Math.abs(denominator) <= EPSILON) continue
    const delta = { x: segmentStart.x - start.x, y: segmentStart.y - start.y }
    const distance = cross(delta, segment) / denominator
    const amount = cross(delta, tangent) / denominator
    if (distance < -EPSILON || amount < -EPSILON || amount > 1 + EPSILON) continue
    if (nearest === undefined || distance < nearest.distance) {
      nearest = {
        point: { x: start.x + tangent.x * distance, y: start.y + tangent.y * distance },
        distance,
      }
    }
  }
  return nearest?.point
}

function closestPointOnGuideAlongTangent(
  start: TerrainRoutePoint,
  tangent: TerrainRoutePoint,
  guide: readonly TerrainRoadGuidePoint[],
): TerrainRoutePoint {
  const closest = closestPointOnGuide(start, guide)
  const distance = Math.max(
    0,
    (closest.x - start.x) * tangent.x + (closest.y - start.y) * tangent.y,
  )
  return { x: start.x + tangent.x * distance, y: start.y + tangent.y * distance }
}

function cross(first: TerrainRoutePoint, second: TerrainRoutePoint): number {
  return first.x * second.y - first.y * second.x
}

/** Build shaped path guides through path-owned bridges and road connectors. */
export function buildPathGuides(
  cells: readonly CellRecord[],
  width: number,
  height: number,
  bridges: readonly TerrainBridgeComponent[],
  connectors: readonly TerrainPathConnector[],
  settings: TerrainRouteSettings,
  rows: readonly string[],
): readonly TerrainPathGuide[] {
  const nodes = new Map<string, PathGraphNode>()
  const bridgeForCell = new Map<string, TerrainBridgeComponent>()
  for (const bridge of bridges) {
    for (const cell of bridge.cells) bridgeForCell.set(cellKey(cell.column, cell.row), bridge)
  }
  const absorbedPathCells = new Set(
    connectors.flatMap((connector) =>
      (connector.absorbedPathCells ?? []).map((cell) => cellKey(cell.column, cell.row)),
    ),
  )
  const pathCells = cells.filter(
    (cell) => cell.material === 'path' && !absorbedPathCells.has(cellKey(cell.column, cell.row)),
  )
  for (const cell of pathCells) {
    const roadContact = CARDINAL_DIRECTIONS.some(([dx, dy]) => {
      const neighbor = cellAt(cells, width, height, cell.column + dx, cell.row + dy)
      if (neighbor?.material === 'road') return true
      if (neighbor?.material !== 'bridge') return false
      return bridgeForCell.get(cellKey(neighbor.column, neighbor.row))?.owner === 'road'
    })
    const id = pathCellNodeId(cell)
    nodes.set(id, {
      id,
      point: { x: cell.column + 0.5, y: cell.row + 0.5 },
      cell: cellCoordinate(cell),
      bridge: false,
      roadContact,
      neighbors: new Set(),
    })
  }
  for (const cell of pathCells) {
    const id = pathCellNodeId(cell)
    for (const [dx, dy] of CARDINAL_DIRECTIONS) {
      const neighbor = cellAt(cells, width, height, cell.column + dx, cell.row + dy)
      if (neighbor?.material === 'path') connectPathNodes(nodes, id, pathCellNodeId(neighbor))
    }
  }

  for (const bridge of bridges.filter((component) => component.owner === 'path')) {
    const deckPoints =
      bridge.deck.kind === 'axis'
        ? required(bridge.deck.axis, 'Oriented path bridge has no axis.')
        : [bridge.deck.center]
    const deckNodes = deckPoints.map((point, index) => {
      const id =
        bridge.deck.kind === 'axis' ? `${bridge.id}-portal-${index}` : `${bridge.id}-center`
      nodes.set(id, {
        id,
        point,
        bridge: true,
        roadContact: false,
        neighbors: new Set(),
      })
      return { id, point }
    })
    for (let index = 1; index < deckNodes.length; index += 1) {
      connectPathNodes(nodes, deckNodes[index - 1]!.id, deckNodes[index]!.id)
    }
    for (const contact of bridge.contacts.filter((item) => item.owner === 'path')) {
      const pathId = pathCellNodeId(contact.neighborCell)
      const pathPoint = nodes.get(pathId)?.point
      if (pathPoint === undefined) continue
      connectPathNodes(nodes, pathId, closestDeckNode(pathPoint, deckNodes).id)
    }
  }

  for (const connector of connectors) {
    const startId = pathCellNodeId(connector.pathCell)
    if (!nodes.has(startId)) continue
    const through =
      connector.oppositePathCell === undefined
        ? [{ id: `${connector.id}-road`, point: connector.end }]
        : (connector.via ?? []).map((point, index) => ({
            id: `${connector.id}-cross-${index}`,
            point,
          }))
    let previousId = startId
    for (const { id, point } of through) {
      nodes.set(id, {
        id,
        point,
        bridge: false,
        roadContact: true,
        neighbors: new Set(),
      })
      connectPathNodes(nodes, previousId, id)
      previousId = id
    }
    if (connector.oppositePathCell !== undefined) {
      connectPathNodes(nodes, previousId, pathCellNodeId(connector.oppositePathCell))
    }
  }

  const sequences = pathGraphChains(nodes)
  const allowedMask = new Set(pathCells.map((cell) => cellKey(cell.column, cell.row)))
  for (const connector of connectors) {
    allowedMask.add(cellKey(connector.roadCell.column, connector.roadCell.row))
    const crossing = [connector.start, ...(connector.via ?? []), connector.end]
    for (let index = 1; index < crossing.length; index += 1) {
      addSegmentCells(
        allowedMask,
        required(crossing[index - 1], 'Path crossing segment start is missing.'),
        required(crossing[index], 'Path crossing segment end is missing.'),
        width,
        height,
      )
    }
  }
  for (const bridge of bridges.filter((component) => component.owner === 'path')) {
    for (const cell of bridge.cells) allowedMask.add(cellKey(cell.column, cell.row))
  }
  const layoutHash = stableHashParts('path-routes', width, height, ...rows)
  return sequences.map(({ ids, closed }, index) => ({
    id: 'path-guide-' + index,
    closed,
    widthCells: settings.path.widthCells,
    points: fairPathGuide(
      ids.map((id) => required(nodes.get(id), 'Path guide node is missing.')),
      closed,
      allowedMask,
      width,
      height,
      settings,
      stableHashParts(layoutHash, ids.join('|')),
    ),
  }))
}

function pathCellNodeId(cell: TerrainRouteCell): string {
  return 'path-' + cell.row + '-' + cell.column
}

function connectPathNodes(
  nodes: Map<string, PathGraphNode>,
  firstId: string,
  secondId: string,
): void {
  if (firstId === secondId) return
  const first = nodes.get(firstId)
  const second = nodes.get(secondId)
  if (first === undefined || second === undefined) return
  first.neighbors.add(secondId)
  second.neighbors.add(firstId)
}

function closestDeckNode<Node extends { readonly point: TerrainRoutePoint }>(
  point: TerrainRoutePoint,
  nodes: readonly Node[],
): Node {
  return required(
    [...nodes].sort(
      (first, second) =>
        (point.x - first.point.x) ** 2 +
        (point.y - first.point.y) ** 2 -
        ((point.x - second.point.x) ** 2 + (point.y - second.point.y) ** 2),
    )[0],
    'Path bridge has no deck node.',
  )
}

function pathGraphChains(
  nodes: ReadonlyMap<string, PathGraphNode>,
): readonly { readonly ids: readonly string[]; readonly closed: boolean }[] {
  const used = new Set<string>()
  const result: Array<{ ids: string[]; closed: boolean }> = []
  const edgeKey = (first: string, second: string): string =>
    first < second ? first + '|' + second : second + '|' + first
  const walk = (start: string, neighbor: string): string[] => {
    const ids = [start]
    let previous = start
    let current = neighbor
    used.add(edgeKey(start, neighbor))
    while (true) {
      ids.push(current)
      const node = required(nodes.get(current), 'Path chain node is missing.')
      if (node.neighbors.size !== 2) break
      const next = [...node.neighbors].sort().find((candidate) => candidate !== previous)
      if (next === undefined || used.has(edgeKey(current, next))) break
      used.add(edgeKey(current, next))
      previous = current
      current = next
    }
    return ids
  }

  const anchors = [...nodes.values()]
    .filter((node) => node.neighbors.size !== 2)
    .sort((first, second) => first.id.localeCompare(second.id))
  for (const anchor of anchors) {
    if (anchor.neighbors.size === 0) {
      result.push({ ids: [anchor.id], closed: false })
      continue
    }
    for (const neighbor of [...anchor.neighbors].sort()) {
      if (used.has(edgeKey(anchor.id, neighbor))) continue
      let ids = walk(anchor.id, neighbor)
      if (
        required(ids.at(-1), 'Open path chain is empty.') <
        required(ids[0], 'Open path chain is empty.')
      ) {
        ids = ids.reverse()
      }
      result.push({ ids, closed: false })
    }
  }

  for (const start of [...nodes.keys()].sort()) {
    const node = required(nodes.get(start), 'Cycle start node is missing.')
    const neighbors = [...node.neighbors].sort()
    const first = neighbors.find((neighbor) => !used.has(edgeKey(start, neighbor)))
    if (first === undefined) continue
    const ids = walk(start, first)
    if (ids.at(-1) === start) ids.pop()
    result.push({ ids, closed: true })
  }
  result.sort(
    (first, second) =>
      first.ids.join('|').localeCompare(second.ids.join('|')) ||
      Number(first.closed) - Number(second.closed),
  )
  return result
}

function fairPathGuide(
  nodes: readonly PathGraphNode[],
  closed: boolean,
  mask: ReadonlySet<string>,
  width: number,
  height: number,
  settings: TerrainRouteSettings,
  seed: number,
): readonly TerrainPathGuidePoint[] {
  const raw = nodes.map((node) => {
    const degree = node.neighbors.size
    const anchor = node.bridge
      ? 'bridge'
      : node.roadContact
        ? 'road'
        : degree > 2
          ? 'junction'
          : degree < 2
            ? 'endpoint'
            : null
    return {
      x: node.point.x,
      y: node.point.y,
      rawX: node.point.x,
      rawY: node.point.y,
      locked: anchor !== null,
      anchor,
      fellBack: false,
    } satisfies TerrainPathGuidePoint
  })
  if (raw.length === 1) return raw
  const shaped = shapeTerrainCurve(
    raw.map((point) => ({ x: point.rawX, y: point.rawY, locked: point.locked })),
    closed,
    settings.path.curve,
    seed,
  )
  return shaped.map((point) => {
    const location = sourceAtOffset(raw, point.sourceOffset)
    const exact = location.exact
    const straightRoadSpan =
      exact === undefined &&
      location.segmentStart?.anchor === 'road' &&
      location.segmentEnd?.anchor === 'road'
    const source = {
      x: location.point.x,
      y: location.point.y,
      rawX: location.point.x,
      rawY: location.point.y,
      locked: straightRoadSpan || (exact?.locked ?? false),
      anchor: straightRoadSpan ? 'road' : (exact?.anchor ?? null),
      fellBack: false,
    } satisfies TerrainPathGuidePoint
    const candidate = straightRoadSpan ? location.point : point
    const valid =
      candidate.x >= 0 &&
      candidate.y >= 0 &&
      candidate.x < width &&
      candidate.y < height &&
      (source.anchor === 'road' ||
        mask.has(cellKey(Math.floor(candidate.x), Math.floor(candidate.y))))
    return valid ? { ...source, x: candidate.x, y: candidate.y } : { ...source, fellBack: true }
  })
}

function addSegmentCells(
  target: Set<string>,
  start: TerrainRoutePoint,
  end: TerrainRoutePoint,
  width: number,
  height: number,
): void {
  const length = Math.hypot(end.x - start.x, end.y - start.y)
  const samples = Math.max(1, Math.ceil(length / 0.25))
  for (let sample = 0; sample <= samples; sample += 1) {
    const amount = sample / samples
    const column = Math.floor(start.x + (end.x - start.x) * amount)
    const row = Math.floor(start.y + (end.y - start.y) * amount)
    if (column >= 0 && row >= 0 && column < width && row < height) {
      target.add(cellKey(column, row))
    }
  }
}
