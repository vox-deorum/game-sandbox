import { EIGHT_DIRECTIONS, cellCoordinate } from './terrain-route-grid.js'
import type { CellRecord } from './terrain-route-grid.js'
import {
  cellAt,
  cellKey,
  compareCells,
  connectedComponents,
  required,
  terrainVariant,
} from './terrain-helpers.js'

import type { TerrainRoadSubstrateCell } from './types.js'

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

const SUBSTRATE_MATERIALS = new Set(['ground', 'field', 'reeds'])

/** Propagate natural substrate provenance across visual road and path cells. */
export function propagateVisualSubstrate(
  cells: readonly CellRecord[],
  width: number,
  height: number,
): readonly TerrainRoadSubstrateCell[] {
  const sources = substrateSources(cells)
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
): readonly SubstrateSource[] {
  const natural = cells.filter((cell) => SUBSTRATE_MATERIALS.has(cell.material))
  const groups = connectedComponents(natural, (first, second) => first.material === second.material)
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


/** Replace route codes with their propagated substrate codes. */
export function replaceRouteCells(
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

/** Materials whose cells the visual grid may rewrite to remove a diagonal-only touch. */
const NORMALIZED_MATERIALS = new Set(['ground', 'field', 'reeds', 'water'])

/**
 * Rewrite the visual grid until no material touches itself only through a cell corner.
 *
 * A one-cell reed strip that steps diagonally is drawn as a string of separate beads: cardinal
 * connectivity makes every fragment its own region, and the corner where two fragments meet is a
 * junction the contour must pin exactly onto the grid. No amount of curve smoothing reaches that
 * shape, because the shape really is disconnected. Flipping a single cell per offending corner
 * either joins the pair edge to edge or parts it cleanly, and the boundary that follows is an
 * ordinary staircase like any other.
 *
 * Each cell may be rewritten once, so the sweep always settles: an overlapping pair of corners
 * cannot trade the same cell back and forth.
 */
export function normalizeDiagonalTouches(
  rows: readonly string[],
  groundNameForCode: Readonly<Record<string, string>>,
): readonly string[] {
  const grid = rows.map((row) => [...row])
  const frozen = new Set<string>()
  const materialAt = (column: number, row: number): string | undefined => {
    const code = grid[row]?.[column]
    if (code === undefined) return undefined
    const semantic = groundNameForCode[code]
    if (semantic === undefined) throw new Error('Visual grid cell is missing its ground name.')
    // Bridge cells share the water surface but keep their own fixed deck geometry.
    return semantic === 'bridge' ? 'bridge' : semantic
  }
  const flip = (column: number, row: number, code: string): boolean => {
    const key = cellKey(column, row)
    if (frozen.has(key)) return false
    frozen.add(key)
    required(grid[row], 'Visual grid row is missing.')[column] = code
    return true
  }

  for (let sweep = 0; ; sweep += 1) {
    if (sweep > rows.length * (rows[0]?.length ?? 0)) {
      throw new Error('Visual grid normalization did not settle.')
    }
    let changed = false
    for (let row = 1; row < grid.length; row += 1) {
      for (let column = 1; column < (grid[row]?.length ?? 0); column += 1) {
        const corners = [
          { column: column - 1, row: row - 1 },
          { column, row: row - 1 },
          { column, row },
          { column: column - 1, row },
        ] as const
        const materials = corners.map((corner) => materialAt(corner.column, corner.row))
        if (materials.some((material) => material === undefined)) continue
        if (!materials.every((material) => NORMALIZED_MATERIALS.has(material!))) continue
        const [northWest, northEast, southEast, southWest] = materials as [
          string,
          string,
          string,
          string,
        ]
        const diagonals =
          northWest === southEast && northWest !== northEast && northWest !== southWest
            ? ([0, 2, 1, 3] as const)
            : northEast === southWest && northEast !== northWest && northEast !== southEast
              ? ([1, 3, 0, 2] as const)
              : undefined
        if (diagonals === undefined) continue
        if (resolveTouch(grid, corners, diagonals, materials as string[], column, row, flip)) {
          changed = true
        }
      }
    }
    if (!changed) break
  }
  return grid.map((row) => row.join(''))
}

/**
 * Settle one corner touch. A checkerboard keeps the winner the saddle routing used to pick, so an
 * ambiguous pair still resolves the same way for a given map. Otherwise the touching pair is
 * joined, preferring to rewrite a cell that is not water so shorelines keep their footprint.
 */
function resolveTouch(
  grid: string[][],
  corners: readonly { readonly column: number; readonly row: number }[],
  diagonals: readonly [number, number, number, number],
  materials: readonly string[],
  column: number,
  row: number,
  flip: (column: number, row: number, code: string) => boolean,
): boolean {
  const [firstDiagonal, secondDiagonal, firstOther, secondOther] = diagonals
  const codeAt = (index: number): string => {
    const corner = required(corners[index], 'Visual grid corner is missing.')
    return required(grid[corner.row], 'Visual grid row is missing.')[corner.column]!
  }
  const touching = required(materials[firstDiagonal], 'Visual grid corner material is missing.')
  const otherFirst = required(materials[firstOther], 'Visual grid corner material is missing.')
  const otherSecond = required(materials[secondOther], 'Visual grid corner material is missing.')

  if (otherFirst === otherSecond) {
    // Both diagonals touch. Keep the pair the saddle rule used to connect and part the other.
    const pair = [touching, otherFirst].sort() as [string, string]
    const winner = pair[terrainVariant(2, 'terrain-saddle', column, row, ...pair)]
    const losers = winner === touching ? [firstOther, secondOther] : [firstDiagonal, secondDiagonal]
    const winnerCode = codeAt(winner === touching ? firstDiagonal : firstOther)
    for (const index of losers) {
      const corner = required(corners[index], 'Visual grid corner is missing.')
      if (flip(corner.column, corner.row, winnerCode)) return true
    }
    return false
  }

  const order = otherFirst === 'water' ? [secondOther, firstOther] : [firstOther, secondOther]
  const joinCode = codeAt(firstDiagonal)
  for (const index of order) {
    const corner = required(corners[index], 'Visual grid corner is missing.')
    if (flip(corner.column, corner.row, joinCode)) return true
  }
  return false
}
