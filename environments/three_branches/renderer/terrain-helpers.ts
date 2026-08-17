/** Pure helpers shared by the Three Branches terrain pipeline. */

import { avalanche, distance, stableHashParts } from '@renderers/base/math.js'

type Point = { readonly x: number; readonly y: number }
type GridCell = { readonly column: number; readonly row: number }

const CARDINAL_OFFSETS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const

/** Tolerance used by terrain geometry comparisons. */
export const EPSILON = 1e-9

/** Return a defined value or throw the supplied terrain diagnostic. */
export function required<Value>(value: Value | undefined, message: string): Value {
  if (value === undefined) throw new Error(message)
  return value
}

/** Project a point onto the nearest position of a line segment. */
export function projectToSegment(point: Point, start: Point, end: Point): Point {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= EPSILON) return start
  const amount = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
  )
  return { x: start.x + dx * amount, y: start.y + dy * amount }
}

/** Measure the distance from a point to the nearest position of a line segment. */
export function pointToSegmentDistance(point: Point, start: Point, end: Point): number {
  return distance(point, projectToSegment(point, start, end))
}

/** Build the stable key for one integer terrain cell. */
export function cellKey(column: number, row: number): string {
  return `${column}:${row}`
}

/** Rotate a list to start at one index, carrying the head round to the tail. */
export function rotate<Item>(items: readonly Item[], index: number): Item[] {
  return [...items.slice(index), ...items.slice(0, index)]
}

/** Sort terrain cells from north to south, then west to east. */
export function compareCells(first: GridCell, second: GridCell): number {
  return first.row - second.row || first.column - second.column
}

/** Read a cell from a row-major rectangular terrain array. */
export function cellAt<Cell>(
  cells: readonly Cell[],
  width: number,
  height: number,
  column: number,
  row: number,
): Cell | undefined {
  if (column < 0 || row < 0 || column >= width || row >= height) return undefined
  return cells[row * width + column]
}

/** Group grid cells through matching cardinal neighbors. */
export function connectedComponents<Cell extends GridCell>(
  cells: readonly Cell[],
  connected: (first: Cell, second: Cell) => boolean,
): Cell[][] {
  const byKey = new Map(cells.map((cell) => [cellKey(cell.column, cell.row), cell]))
  const visited = new Set<string>()
  const components: Cell[][] = []
  for (const start of [...cells].sort(compareCells)) {
    const startKey = cellKey(start.column, start.row)
    if (visited.has(startKey)) continue
    const component: Cell[] = []
    const queue = [start]
    visited.add(startKey)
    for (let index = 0; index < queue.length; index += 1) {
      const cell = queue[index]!
      component.push(cell)
      for (const [dx, dy] of CARDINAL_OFFSETS) {
        const key = cellKey(cell.column + dx, cell.row + dy)
        const neighbor = byKey.get(key)
        if (neighbor === undefined || visited.has(key) || !connected(cell, neighbor)) continue
        visited.add(key)
        queue.push(neighbor)
      }
    }
    components.push(component.sort(compareCells))
  }
  return components
}

/** Pick a stable zero-based terrain art variant. */
export function terrainVariant(
  count: number,
  ...parts: readonly (string | number)[]
): number {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error('Terrain variant count must be positive.')
  }
  return avalanche(stableHashParts(...parts)) % count
}
