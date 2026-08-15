import { shapeTerrainCurve, type TerrainCurveProfile } from './terrain-curves.js'

/** Renderer-local route geometry derived only from the immutable ground grid. */

export type TerrainRouteOwner = 'road' | 'path'
export type TerrainBridgeOrientation = 'horizontal' | 'vertical' | 'compact'

export interface TerrainRouteSettings {
  readonly road: {
    readonly curve: TerrainCurveProfile
    readonly targetWidthCells: number
    readonly minimumWidthCells: number
    readonly opacity: number
  }
  readonly path: {
    readonly curve: TerrainCurveProfile
    readonly widthCells: number
    readonly opacity: number
  }
}

export const DEFAULT_TERRAIN_ROUTE_SETTINGS: TerrainRouteSettings = {
  road: {
    curve: {
      sampleSpacingCells: 0.25,
      smoothingPasses: 10,
      octaves: [{ wavelengthCells: 6, amplitudeCells: 0.05 }],
    },
    targetWidthCells: 2.1,
    minimumWidthCells: 1.6,
    opacity: 0.82,
  },
  path: {
    curve: {
      sampleSpacingCells: 0.2,
      smoothingPasses: 14,
      octaves: [{ wavelengthCells: 7, amplitudeCells: 0.04 }],
    },
    widthCells: 0.7,
    opacity: 1,
  },
}

export interface TerrainRouteCell {
  readonly column: number
  readonly row: number
}

export interface TerrainRoutePoint {
  readonly x: number
  readonly y: number
}

export interface TerrainRoadGuidePoint extends TerrainRoutePoint {
  readonly rawX: number
  readonly rawY: number
  readonly column: number
  readonly locked: boolean
  readonly anchor: 'map' | 'bridge' | null
  readonly fellBack: boolean
  readonly widthCells: number
}

export interface TerrainPathGuidePoint extends TerrainRoutePoint {
  readonly rawX: number
  readonly rawY: number
  readonly locked: boolean
  readonly anchor: 'endpoint' | 'junction' | 'road' | 'bridge' | null
  readonly fellBack: boolean
}

export interface TerrainPathGuide {
  readonly id: string
  readonly closed: boolean
  readonly points: readonly TerrainPathGuidePoint[]
  readonly widthCells: number
}

export interface TerrainBridgeContact {
  readonly side: 'north' | 'east' | 'south' | 'west'
  readonly componentCell: TerrainRouteCell
  readonly neighborCell: TerrainRouteCell
  readonly owner: TerrainRouteOwner
}

export interface TerrainBridgeDeckSpec {
  readonly kind: 'axis' | 'compact'
  readonly widthCells: number
  readonly cap: 'square' | 'round'
  readonly center: TerrainRoutePoint
  readonly axis?: readonly [TerrainRoutePoint, TerrainRoutePoint]
}

export interface TerrainBridgeComponent {
  readonly id: string
  readonly cells: readonly TerrainRouteCell[]
  readonly contacts: readonly TerrainBridgeContact[]
  readonly owner: TerrainRouteOwner
  readonly orientation: TerrainBridgeOrientation
  readonly bounds: {
    readonly minColumn: number
    readonly maxColumn: number
    readonly minRow: number
    readonly maxRow: number
  }
  readonly portals: readonly TerrainRoutePoint[]
  readonly deck: TerrainBridgeDeckSpec
}

export interface TerrainRoadSubstrateCell extends TerrainRouteCell {
  readonly replacedMaterial: 'road' | 'path'
  readonly source: TerrainRouteCell
  readonly sourceCode: string
  readonly sourceMaterial: 'ground' | 'field' | 'reeds'
  readonly sourceComponentId: string
  readonly distance: number
}

export interface TerrainPathConnector {
  readonly id: string
  readonly pathCell: TerrainRouteCell
  /** Present when two path terminals form one uninterrupted crossing beneath the road. */
  readonly oppositePathCell?: TerrainRouteCell
  /** Locked road-guide points that keep an offset crossing tangent-aligned on both banks. */
  readonly via?: readonly TerrainRoutePoint[]
  /** Redundant contact-width cells omitted from the centerline graph. */
  readonly absorbedPathCells?: readonly TerrainRouteCell[]
  readonly roadCell: TerrainRouteCell
  readonly start: TerrainRoutePoint
  readonly end: TerrainRoutePoint
  readonly widthCells: number
}

export interface TerrainRoutePlan {
  readonly width: number
  readonly height: number
  /** Road and path cells replaced by nearby natural material. Bridges retain water semantics. */
  readonly visualRows: readonly string[]
  readonly visualSubstrate: readonly TerrainRoadSubstrateCell[]
  readonly roadSubstrate: readonly TerrainRoadSubstrateCell[]
  readonly roadGuide: readonly TerrainRoadGuidePoint[]
  readonly roadStroke: TerrainRouteSettings['road']
  readonly pathStroke: TerrainRouteSettings['path']
  readonly roadMaskCells: readonly TerrainRouteCell[]
  readonly pathGuides: readonly TerrainPathGuide[]
  readonly pathConnectors: readonly TerrainPathConnector[]
  readonly bridgeComponents: readonly TerrainBridgeComponent[]
}

interface CellRecord extends TerrainRouteCell {
  readonly code: string
  readonly material: string
  readonly index: number
}

interface SubstrateSource {
  readonly cell: CellRecord
  readonly material: TerrainRoadSubstrateCell['sourceMaterial']
  readonly componentId: string
  readonly componentRank: number
}

interface PropagationRecord {
  readonly distance: number
  readonly source: SubstrateSource
}

interface Run {
  readonly minRow: number
  readonly maxRow: number
  readonly medianRow: number
}

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

interface GuideState {
  readonly run: Run
  readonly cost: number
  readonly overlap: number
  readonly signature: readonly number[]
  readonly previous?: GuideState
}

const SUBSTRATE_MATERIALS = new Set(['ground', 'field', 'reeds'])
const CARDINAL_DIRECTIONS = [
  [0, -1, 'north'],
  [1, 0, 'east'],
  [0, 1, 'south'],
  [-1, 0, 'west'],
] as const
const EIGHT_DIRECTIONS = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
] as const
const EPSILON = 1e-9

/** Build natural road substrate, the inset road guide, connectors, and bridge deck specifications. */
export function planTerrainRoutes(
  rows: readonly string[],
  groundNameForCode: Readonly<Record<string, string>>,
  settings: TerrainRouteSettings = DEFAULT_TERRAIN_ROUTE_SETTINGS,
): TerrainRoutePlan {
  const { width, height } = validateInputs(rows, groundNameForCode, settings)
  const cells = buildCells(rows, groundNameForCode, width, height)
  const bridgeComponents = buildBridgeComponents(cells, width, height, settings)
  const bridgeForCell = new Map<string, TerrainBridgeComponent>()
  for (const component of bridgeComponents) {
    for (const cell of component.cells) bridgeForCell.set(cellKey(cell.column, cell.row), component)
  }

  const visualSubstrate = propagateVisualSubstrate(cells, width, height)
  const roadSubstrate = visualSubstrate.filter((cell) => cell.replacedMaterial === 'road')
  const visualRows = replaceRouteCells(rows, visualSubstrate)
  const roadMaskCells = cells
    .filter(
      (cell) =>
        cell.material === 'road' ||
        (cell.material === 'bridge' &&
          bridgeForCell.get(cellKey(cell.column, cell.row))?.owner === 'road'),
    )
    .map(cellCoordinate)
  const roadGuide = buildRoadGuide(rows, width, height, roadMaskCells, bridgeForCell, settings)
  const pathConnectors = buildPathConnectors(
    cells,
    width,
    height,
    roadMaskCells,
    roadGuide,
    settings.path.widthCells,
  )
  const pathGuides = buildPathGuides(
    cells,
    width,
    height,
    bridgeComponents,
    pathConnectors,
    settings,
    rows,
  )
  return {
    width,
    height,
    visualRows,
    visualSubstrate,
    roadSubstrate,
    roadGuide,
    roadStroke: settings.road,
    pathStroke: settings.path,
    roadMaskCells,
    pathGuides,
    pathConnectors,
    bridgeComponents,
  }
}

/** Select source cells into a sparse, top-first character grid. */
export function sparseRows(
  width: number,
  height: number,
  cells: readonly TerrainRouteCell[],
  code: string,
): readonly string[] {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error('Sparse terrain rows require positive integer dimensions.')
  }
  if ([...code].length !== 1)
    throw new Error('Sparse terrain rows require a single-character code.')
  const result = Array.from({ length: height }, () => Array(width).fill(' ') as string[])
  for (const cell of cells) {
    if (
      !Number.isInteger(cell.column) ||
      !Number.isInteger(cell.row) ||
      cell.column < 0 ||
      cell.row < 0 ||
      cell.column >= width ||
      cell.row >= height
    ) {
      throw new Error('Sparse terrain cell is outside the target grid.')
    }
    required(result[cell.row], 'Sparse terrain target row is missing.')[cell.column] = code
  }
  return result.map((row) => row.join(''))
}

function validateInputs(
  rows: readonly string[],
  groundNameForCode: Readonly<Record<string, string>>,
  settings: TerrainRouteSettings,
): { width: number; height: number } {
  const width = rows[0]?.length ?? 0
  if (width === 0 || rows.some((row) => row.length !== width)) {
    throw new Error('Terrain route planning requires a non-empty rectangular grid.')
  }
  for (const code of new Set(rows.join(''))) {
    if (groundNameForCode[code] === undefined) {
      throw new Error(`Terrain code ${JSON.stringify(code)} has no ground name.`)
    }
  }
  const validationLine = [
    { x: 0, y: 0, locked: true },
    { x: 1, y: 0, locked: true },
  ] as const
  shapeTerrainCurve(validationLine, false, settings.road.curve, 0)
  shapeTerrainCurve(validationLine, false, settings.path.curve, 0)
  finiteRange(settings.road.targetWidthCells, 0, 8, 'Road target width')
  finiteRange(
    settings.road.minimumWidthCells,
    0,
    settings.road.targetWidthCells,
    'Minimum road width',
  )
  finiteRange(settings.road.opacity, 0, 1, 'Road opacity', true)
  finiteRange(settings.path.widthCells, 0, 2, 'Path width')
  finiteRange(settings.path.opacity, 0, 1, 'Path opacity', true)
  return { width, height: rows.length }
}

function finiteRange(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
  allowMinimum = false,
): void {
  if (
    !Number.isFinite(value) ||
    (allowMinimum ? value < minimum : value <= minimum) ||
    value > maximum
  ) {
    throw new Error(
      `${name} must be ${allowMinimum ? 'between' : 'greater than'} ${minimum} and at most ${maximum}.`,
    )
  }
}

function buildCells(
  rows: readonly string[],
  groundNameForCode: Readonly<Record<string, string>>,
  width: number,
  height: number,
): CellRecord[] {
  const cells: CellRecord[] = []
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const code = required(rows[row]?.[column], 'Validated terrain route cell is missing.')
      const material = required(
        groundNameForCode[code],
        'Validated terrain route material is missing.',
      )
      cells.push({
        column,
        row,
        code,
        material,
        index: row * width + column,
      })
    }
  }
  return cells
}

function cellAt(
  cells: readonly CellRecord[],
  width: number,
  height: number,
  column: number,
  row: number,
): CellRecord | undefined {
  if (column < 0 || row < 0 || column >= width || row >= height) return undefined
  return cells[row * width + column]
}

function propagateVisualSubstrate(
  cells: readonly CellRecord[],
  width: number,
  height: number,
): readonly TerrainRoadSubstrateCell[] {
  const sources = substrateSources(cells, width, height)
  const sourceForIndex = new Map(sources.map((source) => [source.cell.index, source]))
  const routeCells = cells.filter((cell) => cell.material === 'road' || cell.material === 'path')
  const routeIndices = new Set(routeCells.map((cell) => cell.index))
  const result = new Map<number, PropagationRecord>()
  const queue: CellRecord[] = []

  for (const route of routeCells) {
    for (const [dx, dy] of EIGHT_DIRECTIONS) {
      const neighbor = cellAt(cells, width, height, route.column + dx, route.row + dy)
      const source = neighbor === undefined ? undefined : sourceForIndex.get(neighbor.index)
      if (source === undefined) continue
      const candidate = { distance: 1, source }
      if (betterPropagation(candidate, result.get(route.index))) {
        result.set(route.index, candidate)
        queue.push(route)
      }
    }
  }

  for (let index = 0; index < queue.length; index += 1) {
    const current = required(queue[index], 'Road substrate queue entry is missing.')
    const currentRecord = required(
      result.get(current.index),
      'Road substrate propagation record is missing.',
    )
    for (const [dx, dy] of EIGHT_DIRECTIONS) {
      const neighbor = cellAt(cells, width, height, current.column + dx, current.row + dy)
      if (neighbor === undefined || !routeIndices.has(neighbor.index)) continue
      const candidate = { distance: currentRecord.distance + 1, source: currentRecord.source }
      if (!betterPropagation(candidate, result.get(neighbor.index))) continue
      result.set(neighbor.index, candidate)
      queue.push(neighbor)
    }
  }

  if (result.size !== routeCells.length) {
    const unresolved = required(
      routeCells.find((cell) => !result.has(cell.index)),
      'Unresolved route substrate cell is missing.',
    )
    throw new Error(
      `Route component at column ${unresolved.column}, row ${unresolved.row} has no ground, field, or reeds substrate source.`,
    )
  }

  return routeCells.map((cell) => {
    const propagated = required(
      result.get(cell.index),
      'Resolved road substrate record is missing.',
    )
    const source = propagated.source
    return {
      column: cell.column,
      row: cell.row,
      replacedMaterial: cell.material as 'road' | 'path',
      source: cellCoordinate(source.cell),
      sourceCode: source.cell.code,
      sourceMaterial: source.material,
      sourceComponentId: source.componentId,
      distance: propagated.distance,
    }
  })
}

function substrateSources(
  cells: readonly CellRecord[],
  width: number,
  height: number,
): readonly SubstrateSource[] {
  const visited = new Set<number>()
  const groups: CellRecord[][] = []
  for (const start of cells) {
    if (!SUBSTRATE_MATERIALS.has(start.material) || visited.has(start.index)) continue
    const group: CellRecord[] = []
    const queue = [start]
    visited.add(start.index)
    for (let index = 0; index < queue.length; index += 1) {
      const cell = required(queue[index], 'Substrate component queue entry is missing.')
      group.push(cell)
      for (const [dx, dy] of CARDINAL_DIRECTIONS) {
        const next = cellAt(cells, width, height, cell.column + dx, cell.row + dy)
        if (next === undefined || next.material !== start.material || visited.has(next.index))
          continue
        visited.add(next.index)
        queue.push(next)
      }
    }
    groups.push(group.sort(compareCells))
  }
  groups.sort((first, second) => {
    const firstCell = required(first[0], 'Substrate component is empty.')
    const secondCell = required(second[0], 'Substrate component is empty.')
    return (
      compareCells(firstCell, secondCell) || firstCell.material.localeCompare(secondCell.material)
    )
  })
  return groups.flatMap((group, componentRank) => {
    const first = required(group[0], 'Substrate component is empty.')
    const componentId = `substrate-${first.row}-${first.column}-${first.material}`
    return group.map((cell) => ({
      cell,
      material: cell.material as SubstrateSource['material'],
      componentId,
      componentRank,
    }))
  })
}

function betterPropagation(
  candidate: PropagationRecord,
  previous: PropagationRecord | undefined,
): boolean {
  if (previous === undefined) return true
  return comparePropagation(candidate, previous) < 0
}

function comparePropagation(first: PropagationRecord, second: PropagationRecord): number {
  return (
    first.distance - second.distance ||
    first.source.componentRank - second.source.componentRank ||
    first.source.cell.row - second.source.cell.row ||
    first.source.cell.column - second.source.cell.column
  )
}

function replaceRouteCells(
  rows: readonly string[],
  substrate: readonly TerrainRoadSubstrateCell[],
): readonly string[] {
  const result = rows.map((row) => [...row])
  for (const cell of substrate) {
    required(result[cell.row], 'Road substrate target row is missing.')[cell.column] =
      cell.sourceCode
  }
  return result.map((row) => row.join(''))
}

function buildBridgeComponents(
  cells: readonly CellRecord[],
  width: number,
  height: number,
  settings: TerrainRouteSettings,
): readonly TerrainBridgeComponent[] {
  const visited = new Set<number>()
  const result: TerrainBridgeComponent[] = []
  for (const start of cells) {
    if (start.material !== 'bridge' || visited.has(start.index)) continue
    const component: CellRecord[] = []
    const queue = [start]
    visited.add(start.index)
    for (let index = 0; index < queue.length; index += 1) {
      const cell = required(queue[index], 'Bridge component queue entry is missing.')
      component.push(cell)
      for (const [dx, dy] of CARDINAL_DIRECTIONS) {
        const next = cellAt(cells, width, height, cell.column + dx, cell.row + dy)
        if (next === undefined || next.material !== 'bridge' || visited.has(next.index)) continue
        visited.add(next.index)
        queue.push(next)
      }
    }
    component.sort(compareCells)
    result.push(finishBridgeComponent(component, cells, width, height, settings))
  }
  return result
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
      cap: axis === undefined ? 'round' : 'square',
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

function buildRoadGuide(
  rows: readonly string[],
  width: number,
  height: number,
  roadMaskCells: readonly TerrainRouteCell[],
  bridgeForCell: ReadonlyMap<string, TerrainBridgeComponent>,
  settings: TerrainRouteSettings,
): readonly TerrainRoadGuidePoint[] {
  if (roadMaskCells.length === 0) return []
  const fullMask = new Set(roadMaskCells.map((cell) => cellKey(cell.column, cell.row)))
  const spanning = cardinalMaskComponents(roadMaskCells, fullMask).filter((component) =>
    Array.from({ length: width }, (_, column) =>
      component.some((cell) => cell.column === column),
    ).every(Boolean),
  )
  if (spanning.length === 0) {
    const missingColumn = Array.from(
      { length: width },
      (_, column) => !roadMaskCells.some((cell) => cell.column === column),
    ).findIndex(Boolean)
    throw new Error(
      missingColumn >= 0
        ? `The inset road route does not span column ${missingColumn}.`
        : 'The inset road route has no cardinally continuous west-to-east component.',
    )
  }
  const selections = spanning.map((component) => {
    const mask = new Set(component.map((cell) => cellKey(cell.column, cell.row)))
    return { component, mask, ...selectRoadRuns(width, height, mask) }
  })
  selections.sort(
    (first, second) =>
      compareGuideStates(first.state, second.state) ||
      compareCells(
        required(first.component[0], 'Road component is empty.'),
        required(second.component[0], 'Road component is empty.'),
      ),
  )
  const selection = required(selections[0], 'Spanning road selection is missing.')
  const { mask, selected } = selection

  const raw = selected.map((run, column) => {
    const bridges = Array.from(
      new Set(
        Array.from({ length: run.maxRow - run.minRow + 1 }, (_, index) => run.minRow + index)
          .map((row) => bridgeForCell.get(cellKey(column, row)))
          .filter((component): component is TerrainBridgeComponent => component?.owner === 'road'),
      ),
    ).sort((first, second) => first.id.localeCompare(second.id))
    const bridge = bridges[0]
    const rawY = bridge?.orientation === 'horizontal' ? bridge.deck.center.y : run.medianRow + 0.5
    const anchor =
      column === 0 || column === width - 1 ? 'map' : bridge === undefined ? null : 'bridge'
    return {
      x: column + 0.5,
      y: rawY,
      rawX: column + 0.5,
      rawY,
      column,
      locked: anchor !== null,
      anchor,
      fellBack: false,
      widthCells: settings.road.targetWidthCells,
    } satisfies TerrainRoadGuidePoint
  })
  return fairRoadGuide(raw, rows, width, height, mask, settings)
}

function cardinalMaskComponents(
  cells: readonly TerrainRouteCell[],
  mask: ReadonlySet<string>,
): readonly TerrainRouteCell[][] {
  const byKey = new Map(cells.map((cell) => [cellKey(cell.column, cell.row), cell]))
  const visited = new Set<string>()
  const result: TerrainRouteCell[][] = []
  for (const start of [...cells].sort(compareCells)) {
    const startKey = cellKey(start.column, start.row)
    if (visited.has(startKey)) continue
    const component: TerrainRouteCell[] = []
    const queue = [start]
    visited.add(startKey)
    for (let index = 0; index < queue.length; index += 1) {
      const cell = required(queue[index], 'Road component queue entry is missing.')
      component.push(cell)
      for (const [dx, dy] of CARDINAL_DIRECTIONS) {
        const key = cellKey(cell.column + dx, cell.row + dy)
        if (!mask.has(key) || visited.has(key)) continue
        const neighbor = byKey.get(key)
        if (neighbor === undefined) continue
        visited.add(key)
        queue.push(neighbor)
      }
    }
    component.sort(compareCells)
    result.push(component)
  }
  return result
}

function selectRoadRuns(
  width: number,
  height: number,
  mask: ReadonlySet<string>,
): { readonly selected: readonly Run[]; readonly state: GuideState } {
  const runsByColumn = Array.from({ length: width }, (_, column) =>
    columnRuns(column, height, mask),
  )
  let states = required(runsByColumn[0], 'First road-run column is missing.').map<GuideState>(
    (run) => ({
      run,
      cost: 0,
      overlap: 0,
      signature: [run.medianRow, run.minRow, run.maxRow],
    }),
  )
  for (let column = 1; column < width; column += 1) {
    const next: GuideState[] = []
    for (const run of required(runsByColumn[column], 'Road-run column is missing.')) {
      const candidates = states
        .filter((previous) => runOverlap(previous.run, run) > 0)
        .map<GuideState>((previous) => ({
          run,
          cost: previous.cost + (run.medianRow - previous.run.medianRow) ** 2,
          overlap: previous.overlap + runOverlap(previous.run, run),
          signature: [...previous.signature, run.medianRow, run.minRow, run.maxRow],
          previous,
        }))
      candidates.sort(compareGuideStates)
      if (candidates[0] !== undefined) next.push(candidates[0])
    }
    states = next
  }
  states.sort(compareGuideStates)
  const state = required(states[0], 'Cardinal road component has no reachable west-to-east run.')
  const selected: Run[] = []
  for (let item: GuideState | undefined = state; item !== undefined; item = item.previous) {
    selected.push(item.run)
  }
  selected.reverse()
  return { selected, state }
}

function columnRuns(column: number, height: number, mask: ReadonlySet<string>): readonly Run[] {
  const result: Run[] = []
  let start: number | null = null
  for (let row = 0; row <= height; row += 1) {
    if (row < height && mask.has(cellKey(column, row))) {
      if (start === null) start = row
      continue
    }
    if (start === null) continue
    const maxRow = row - 1
    result.push({ minRow: start, maxRow, medianRow: (start + maxRow) / 2 })
    start = null
  }
  return result
}

function runOverlap(first: Run, second: Run): number {
  return Math.max(
    0,
    Math.min(first.maxRow, second.maxRow) - Math.max(first.minRow, second.minRow) + 1,
  )
}

function compareGuideStates(first: GuideState, second: GuideState): number {
  return (
    first.cost - second.cost ||
    second.overlap - first.overlap ||
    compareNumberArrays(first.signature, second.signature)
  )
}

function compareNumberArrays(first: readonly number[], second: readonly number[]): number {
  for (let index = 0; index < Math.min(first.length, second.length); index += 1) {
    const difference =
      required(first[index], 'Road guide signature value is missing.') -
      required(second[index], 'Road guide signature value is missing.')
    if (difference !== 0) return difference
  }
  return first.length - second.length
}

function fairRoadGuide(
  raw: readonly TerrainRoadGuidePoint[],
  rows: readonly string[],
  width: number,
  height: number,
  mask: ReadonlySet<string>,
  settings: TerrainRouteSettings,
): readonly TerrainRoadGuidePoint[] {
  const layoutHash = terrainHash('road-route', width, height, ...rows)
  const shaped = shapeTerrainCurve(
    raw.map((point) => ({ x: point.rawX, y: point.rawY, locked: point.locked })),
    false,
    settings.road.curve,
    layoutHash,
  )
  return shaped.map((point, index) => {
    const source = roadSourceAtOffset(raw, point.sourceOffset)
    const previous = shaped[index - 1]
    const next = shaped[index + 1]
    const candidateWidth = roadWidthAt(point, mask, width, height, settings.road.targetWidthCells)
    const valid =
      point.x >= 0 &&
      point.y >= 0 &&
      point.x < width &&
      point.y < height &&
      mask.has(cellKey(Math.floor(point.x), Math.floor(point.y))) &&
      candidateWidth + EPSILON >= settings.road.minimumWidthCells &&
      (previous === undefined || point.x > previous.x + EPSILON) &&
      (next === undefined || point.x < next.x - EPSILON)
    const chosen = valid ? point : { x: source.rawX, y: source.rawY }
    const availableWidth = roadWidthAt(chosen, mask, width, height, settings.road.targetWidthCells)
    const widthCells = Math.max(settings.road.minimumWidthCells, availableWidth)
    const footprintFallback = availableWidth + EPSILON < settings.road.minimumWidthCells
    return valid
      ? { ...source, x: point.x, y: point.y, widthCells }
      : {
          ...source,
          x: source.rawX,
          y: source.rawY,
          fellBack: !source.locked || footprintFallback,
          widthCells,
        }
  })
}

function roadSourceAtOffset(
  raw: readonly TerrainRoadGuidePoint[],
  sourceOffset: number,
): TerrainRoadGuidePoint {
  const location = sourceAtOffset(raw, sourceOffset)
  const exact = location.exact
  return {
    x: location.point.x,
    y: location.point.y,
    rawX: location.point.x,
    rawY: location.point.y,
    column: Math.min(
      required(raw.at(-1), 'Raw road guide is empty.').column,
      Math.max(required(raw[0], 'Raw road guide is empty.').column, Math.floor(location.point.x)),
    ),
    locked: exact?.locked ?? false,
    anchor: exact?.anchor ?? null,
    fellBack: false,
    widthCells: exact?.widthCells ?? required(raw[0], 'Raw road guide is empty.').widthCells,
  }
}

function sourceAtOffset<Value extends TerrainRoutePoint>(
  source: readonly Value[],
  targetOffset: number,
): {
  readonly point: TerrainRoutePoint
  readonly exact?: Value
  readonly segmentStart?: Value
  readonly segmentEnd?: Value
} {
  let offset = 0
  for (let index = 0; index < source.length; index += 1) {
    const start = required(source[index], 'Route curve source point is missing.')
    if (Math.abs(targetOffset - offset) <= EPSILON) return { point: start, exact: start }
    const end = source[index + 1]
    if (end === undefined) return { point: start, exact: start }
    const length = Math.hypot(end.x - start.x, end.y - start.y)
    if (targetOffset <= offset + length + EPSILON) {
      const amount = length <= EPSILON ? 0 : (targetOffset - offset) / length
      return {
        point: {
          x: start.x + (end.x - start.x) * amount,
          y: start.y + (end.y - start.y) * amount,
        },
        segmentStart: start,
        segmentEnd: end,
        ...(Math.abs(targetOffset - (offset + length)) <= EPSILON ? { exact: end } : {}),
      }
    }
    offset += length
  }
  const last = required(source.at(-1), 'Route curve source is empty.')
  return { point: last, exact: last }
}

function roadWidthAt(
  point: TerrainRoutePoint,
  mask: ReadonlySet<string>,
  width: number,
  height: number,
  targetWidth: number,
): number {
  let clearance = Number.POSITIVE_INFINITY
  for (const key of mask) {
    const [columnText, rowText] = key.split(':')
    const column = Number(columnText)
    const row = Number(rowText)
    const exposed = [
      { dx: 0, dy: -1, start: { x: column, y: row }, end: { x: column + 1, y: row } },
      {
        dx: 1,
        dy: 0,
        start: { x: column + 1, y: row },
        end: { x: column + 1, y: row + 1 },
      },
      {
        dx: 0,
        dy: 1,
        start: { x: column + 1, y: row + 1 },
        end: { x: column, y: row + 1 },
      },
      { dx: -1, dy: 0, start: { x: column, y: row + 1 }, end: { x: column, y: row } },
    ] as const
    for (const edge of exposed) {
      if (mask.has(cellKey(column + edge.dx, row + edge.dy))) continue
      const onMapPortal =
        (edge.dx === -1 && column === 0) ||
        (edge.dx === 1 && column === width - 1) ||
        (edge.dy === -1 && row === 0) ||
        (edge.dy === 1 && row === height - 1)
      if (onMapPortal) continue
      clearance = Math.min(clearance, distanceToSegment(point, edge.start, edge.end))
    }
  }
  return Math.min(targetWidth, clearance * 2)
}

function distanceToSegment(
  point: TerrainRoutePoint,
  start: TerrainRoutePoint,
  end: TerrainRoutePoint,
): number {
  const closest = closestPointOnSegment(point, start, end)
  return Math.hypot(point.x - closest.x, point.y - closest.y)
}

function buildPathConnectors(
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
    ...CARDINAL_DIRECTIONS.map(([dx, dy]) =>
      cellAt(cells, width, height, path.column + dx, path.row + dy),
    )
      .filter((cell): cell is CellRecord => cell?.material === 'path')
      .map((cell) => normalizedVector({ x: path.column - cell.column, y: path.row - cell.row }))
      .map((incoming) => incoming.x * tangent.x + incoming.y * tangent.y),
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

/** Return the width guaranteed by the segment strokes used by roadGuideMask. */
export function roadMaskWidthAt(
  point: TerrainRoutePoint,
  guide: readonly TerrainRoadGuidePoint[],
): number {
  let width = required(guide[0], 'Road guide is empty.').widthCells
  let closestDistance = Number.POSITIVE_INFINITY
  for (let index = 1; index < guide.length; index += 1) {
    const start = required(guide[index - 1], 'Road guide segment start is missing.')
    const end = required(guide[index], 'Road guide segment end is missing.')
    const dx = end.x - start.x
    const dy = end.y - start.y
    const lengthSquared = dx * dx + dy * dy
    const amount =
      lengthSquared <= EPSILON
        ? 0
        : Math.max(
            0,
            Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
          )
    const candidate = { x: start.x + dx * amount, y: start.y + dy * amount }
    const distance = (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2
    if (distance + EPSILON >= closestDistance) continue
    closestDistance = distance
    width = Math.min(start.widthCells, end.widthCells)
  }
  return width
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
  const incoming = CARDINAL_DIRECTIONS.map(([dx, dy]) =>
    cellAt(cells, width, height, path.column + dx, path.row + dy),
  )
    .filter((cell): cell is CellRecord => cell?.material === 'path')
    .map((cell) => ({
      cell,
      tangent: normalizedVector({
        x: path.column - cell.column,
        y: path.row - cell.row,
      }),
    }))
    .sort((first, second) => {
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

function buildPathGuides(
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
    if (bridge.deck.kind === 'axis') {
      const axis = required(bridge.deck.axis, 'Oriented path bridge has no axis.')
      const portalIds = [bridge.id + '-portal-0', bridge.id + '-portal-1'] as const
      for (let index = 0; index < portalIds.length; index += 1) {
        const id = required(portalIds[index], 'Path bridge portal id is missing.')
        nodes.set(id, {
          id,
          point: required(axis[index], 'Path bridge portal is missing.'),
          bridge: true,
          roadContact: false,
          neighbors: new Set(),
        })
      }
      connectPathNodes(nodes, portalIds[0], portalIds[1])
      for (const contact of bridge.contacts.filter((item) => item.owner === 'path')) {
        const pathId = pathCellNodeId(contact.neighborCell)
        if (!nodes.has(pathId)) continue
        const portalIndex =
          bridge.orientation === 'horizontal'
            ? contact.side === 'west'
              ? 0
              : contact.side === 'east'
                ? 1
                : closestPortalIndex(nodes.get(pathId)?.point, axis)
            : contact.side === 'north'
              ? 0
              : contact.side === 'south'
                ? 1
                : closestPortalIndex(nodes.get(pathId)?.point, axis)
        connectPathNodes(nodes, pathId, required(portalIds[portalIndex], 'Portal id is missing.'))
      }
    } else {
      const id = bridge.id + '-center'
      nodes.set(id, {
        id,
        point: bridge.deck.center,
        bridge: true,
        roadContact: false,
        neighbors: new Set(),
      })
      for (const contact of bridge.contacts.filter((item) => item.owner === 'path')) {
        const pathId = pathCellNodeId(contact.neighborCell)
        if (nodes.has(pathId)) connectPathNodes(nodes, pathId, id)
      }
    }
  }

  for (const connector of connectors) {
    const startId = pathCellNodeId(connector.pathCell)
    if (!nodes.has(startId)) continue
    if (connector.oppositePathCell !== undefined) {
      let previousId = startId
      for (let viaIndex = 0; viaIndex < (connector.via?.length ?? 0); viaIndex += 1) {
        const id = `${connector.id}-cross-${viaIndex}`
        nodes.set(id, {
          id,
          point: required(connector.via?.[viaIndex], 'Path crossing point is missing.'),
          bridge: false,
          roadContact: true,
          neighbors: new Set(),
        })
        connectPathNodes(nodes, previousId, id)
        previousId = id
      }
      connectPathNodes(nodes, previousId, pathCellNodeId(connector.oppositePathCell))
      continue
    }
    const endId = connector.id + '-road'
    nodes.set(endId, {
      id: endId,
      point: connector.end,
      bridge: false,
      roadContact: true,
      neighbors: new Set(),
    })
    connectPathNodes(nodes, startId, endId)
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
  const layoutHash = terrainHash('path-routes', width, height, ...rows)
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
      terrainHash(layoutHash, ids.join('|')),
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

function closestPortalIndex(
  point: TerrainRoutePoint | undefined,
  portals: readonly [TerrainRoutePoint, TerrainRoutePoint],
): 0 | 1 {
  if (point === undefined) return 0
  const first = (point.x - portals[0].x) ** 2 + (point.y - portals[0].y) ** 2
  const second = (point.x - portals[1].x) ** 2 + (point.y - portals[1].y) ** 2
  return first <= second ? 0 : 1
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

function closestPointOnGuide(
  point: TerrainRoutePoint,
  guide: readonly TerrainRoadGuidePoint[],
): TerrainRoutePoint {
  let closest: TerrainRoutePoint = required(guide[0], 'Road guide is empty.')
  let closestDistance = Number.POSITIVE_INFINITY
  for (let index = 1; index < guide.length; index += 1) {
    const candidate = closestPointOnSegment(
      point,
      required(guide[index - 1], 'Previous road guide point is missing.'),
      required(guide[index], 'Road guide point is missing.'),
    )
    const distance = (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2
    if (distance + EPSILON < closestDistance) {
      closest = candidate
      closestDistance = distance
    }
  }
  return closest
}

function closestPointOnSegment(
  point: TerrainRoutePoint,
  start: TerrainRoutePoint,
  end: TerrainRoutePoint,
): TerrainRoutePoint {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return start
  const amount = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
  )
  return { x: start.x + dx * amount, y: start.y + dy * amount }
}

function canonicalCodeFor(
  material: string,
  groundNameForCode: Readonly<Record<string, string>>,
): string | undefined {
  return Object.keys(groundNameForCode)
    .filter((code) => groundNameForCode[code] === material)
    .sort()[0]
}

function compareCells(first: TerrainRouteCell, second: TerrainRouteCell): number {
  return first.row - second.row || first.column - second.column
}

function cellCoordinate(cell: TerrainRouteCell): TerrainRouteCell {
  return { column: cell.column, row: cell.row }
}

function sideRank(side: TerrainBridgeContact['side']): number {
  return { north: 0, east: 1, south: 2, west: 3 }[side]
}

function cellKey(column: number, row: number): string {
  return `${column}:${row}`
}

function required<Value>(value: Value | undefined, message: string): Value {
  if (value === undefined) throw new Error(message)
  return value
}

function terrainHash(...parts: readonly (string | number)[]): number {
  let value = 2166136261
  for (const part of parts) {
    for (const character of String(part)) {
      value ^= character.charCodeAt(0)
      value = Math.imul(value, 16777619)
    }
    value ^= 31
    value = Math.imul(value, 16777619)
  }
  value ^= value >>> 16
  value = Math.imul(value, 0x7feb352d)
  value ^= value >>> 15
  value = Math.imul(value, 0x846ca68b)
  value ^= value >>> 16
  return value >>> 0
}
