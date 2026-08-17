import type {
  TerrainBridgeComponent,
  TerrainBridgeContact,
  TerrainBridgeOrientation,
  TerrainRouteOwner,
  TerrainRouteSettings,
} from '../core/types.js'
import { cellAt, connectedComponents, required } from './terrain-helpers.js'
import type { CellRecord } from './terrain-route-grid.js'
import { CARDINAL_DIRECTIONS, cellCoordinate } from './terrain-route-grid.js'

/** Build deterministic bridge components and their deck specifications. */
export function buildBridgeComponents(
  cells: readonly CellRecord[],
  width: number,
  height: number,
  settings: TerrainRouteSettings,
): readonly TerrainBridgeComponent[] {
  return connectedComponents(
    cells.filter((cell) => cell.material === 'bridge'),
    () => true,
  ).map((component) => finishBridgeComponent(component, cells, width, height, settings))
}

function finishBridgeComponent(
  cellsInComponent: readonly CellRecord[],
  cells: readonly CellRecord[],
  width: number,
  height: number,
  settings: TerrainRouteSettings,
): TerrainBridgeComponent {
  const contacts: TerrainBridgeContact[] = []
  let minColumn = Number.POSITIVE_INFINITY
  let maxColumn = Number.NEGATIVE_INFINITY
  let minRow = Number.POSITIVE_INFINITY
  let maxRow = Number.NEGATIVE_INFINITY
  for (const cell of cellsInComponent) {
    minColumn = Math.min(minColumn, cell.column)
    maxColumn = Math.max(maxColumn, cell.column)
    minRow = Math.min(minRow, cell.row)
    maxRow = Math.max(maxRow, cell.row)
    for (const [dx, dy, side] of CARDINAL_DIRECTIONS) {
      const neighbor = cellAt(cells, width, height, cell.column + dx, cell.row + dy)
      if (neighbor?.material !== 'road' && neighbor?.material !== 'path') continue
      contacts.push({
        side,
        componentCell: cellCoordinate(cell),
        neighborCell: cellCoordinate(neighbor),
        owner: neighbor.material,
      })
    }
  }
  contacts.sort(
    (first, second) =>
      first.componentCell.row - second.componentCell.row ||
      first.componentCell.column - second.componentCell.column ||
      sideRank(first.side) - sideRank(second.side) ||
      first.owner.localeCompare(second.owner),
  )
  const orientation = bridgeOrientation(contacts, minColumn, maxColumn, minRow, maxRow)
  const owner = bridgeOwner(contacts, orientation)
  const center = {
    x: (minColumn + maxColumn + 1) / 2,
    y: (minRow + maxRow + 1) / 2,
  }
  const axis =
    orientation === 'horizontal'
      ? ([
          { x: minColumn, y: center.y },
          { x: maxColumn + 1, y: center.y },
        ] as const)
      : orientation === 'vertical'
        ? ([
            { x: center.x, y: minRow },
            { x: center.x, y: maxRow + 1 },
          ] as const)
        : undefined
  const portals = axis === undefined ? [] : [axis[0], axis[1]]
  const first = required(cellsInComponent[0], 'Bridge component is empty.')
  return {
    id: `bridge-${first.row}-${first.column}`,
    cells: cellsInComponent.map(cellCoordinate),
    contacts,
    owner,
    orientation,
    bounds: { minColumn, maxColumn, minRow, maxRow },
    portals,
    deck: {
      kind: axis === undefined ? 'compact' : 'axis',
      widthCells: owner === 'road' ? settings.road.targetWidthCells : settings.path.widthCells,
      cap: axis === undefined ? 'round' : 'butt',
      center,
      ...(axis === undefined ? {} : { axis }),
    },
  }
}

function bridgeOrientation(
  contacts: readonly TerrainBridgeContact[],
  minColumn: number,
  maxColumn: number,
  minRow: number,
  maxRow: number,
): TerrainBridgeOrientation {
  const count = { north: 0, east: 0, south: 0, west: 0 }
  for (const contact of contacts) count[contact.side] += 1
  const horizontalPair = count.east > 0 && count.west > 0
  const verticalPair = count.north > 0 && count.south > 0
  if (horizontalPair !== verticalPair) return horizontalPair ? 'horizontal' : 'vertical'
  const horizontalContacts = count.east + count.west
  const verticalContacts = count.north + count.south
  if (horizontalContacts !== verticalContacts) {
    return horizontalContacts > verticalContacts ? 'horizontal' : 'vertical'
  }
  const horizontalSpan = maxColumn - minColumn + 1
  const verticalSpan = maxRow - minRow + 1
  if (horizontalSpan !== verticalSpan)
    return horizontalSpan > verticalSpan ? 'horizontal' : 'vertical'
  return 'compact'
}

function bridgeOwner(
  contacts: readonly TerrainBridgeContact[],
  orientation: TerrainBridgeOrientation,
): TerrainRouteOwner {
  const relevant = contacts.filter((contact) => {
    if (orientation === 'horizontal') return contact.side === 'east' || contact.side === 'west'
    if (orientation === 'vertical') return contact.side === 'north' || contact.side === 'south'
    return true
  })
  const considered = relevant.length === 0 ? contacts : relevant
  return considered.some((contact) => contact.owner === 'road') ? 'road' : 'path'
}

function sideRank(side: TerrainBridgeContact['side']): number {
  return { north: 0, east: 1, south: 2, west: 3 }[side]
}
