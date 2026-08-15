import { CARDINAL_DIRECTIONS, EIGHT_DIRECTIONS, cellCoordinate } from './terrain-route-grid.js'
import type { CellRecord } from './terrain-route-grid.js'
import { cellAt, compareCells, required } from './terrain-helpers.js'

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
