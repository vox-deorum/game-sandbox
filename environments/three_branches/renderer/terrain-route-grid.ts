import { shapeTerrainCurve } from './terrain-curves.js'
import { required } from './terrain-helpers.js'

import type { TerrainRouteCell, TerrainRouteSettings } from './types.js'

/** One validated route-grid cell with its original code and material. */
export interface CellRecord extends TerrainRouteCell {
  readonly code: string
  readonly material: string
  readonly index: number
}

/** Cardinal neighbor offsets in deterministic clockwise order. */
export const CARDINAL_DIRECTIONS = [
  [0, -1, 'north'],
  [1, 0, 'east'],
  [0, 1, 'south'],
  [-1, 0, 'west'],
] as const

/** Eight-neighbor offsets in deterministic row-major order. */
export const EIGHT_DIRECTIONS = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
] as const

/** Validate route inputs and return the rectangular grid dimensions. */
export function validateInputs(
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

/** Build row-major route cells after validation. */
export function buildCells(
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

/** Copy a route cell coordinate without its implementation details. */
export function cellCoordinate(cell: TerrainRouteCell): TerrainRouteCell {
  return { column: cell.column, row: cell.row }
}
