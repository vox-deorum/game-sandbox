import { connectedComponents } from './terrain-helpers.js'
import type { TerrainContourCell } from './types.js'
/** The material outside the authored grid. It closes every map-edge face. */
export const TERRAIN_EXTERIOR = '__exterior__'

/** Materials whose boundaries may be shaped into contours. */
export const CONTOURED_MATERIALS = new Set(['ground', 'field', 'reeds', 'water', 'road', 'path'])
/** Materials whose boundaries remain fixed in the contour graph. */
export const FIXED_MATERIALS = new Set(['interior', 'doorway', 'wall', TERRAIN_EXTERIOR])

/** A semantic map cell with a stable grid index. */
export interface CellRecord extends TerrainContourCell {
  readonly index: number
}

/** A connected material component while contour planning is in progress. */
export interface ComponentRecord {
  readonly key: string
  readonly material: string
  readonly exterior: boolean
  readonly cells: readonly CellRecord[]
  id: string
  outerRingId: string
  holeRingIds: readonly string[]
}

export function validateInputs(
  rows: readonly string[],
  groundNameForCode: Readonly<Record<string, string>>,
): { width: number; height: number } {
  const width = rows[0]?.length ?? 0
  if (width === 0 || rows.some((row) => row.length !== width)) {
    throw new Error('Terrain contour planning requires a non-empty rectangular grid.')
  }
  for (const code of new Set(rows.join(''))) {
    const semantic = groundNameForCode[code]
    if (semantic === undefined)
      throw new Error(`Terrain code ${JSON.stringify(code)} has no ground name.`)
    const material = materialForSemantic(semantic)
    if (!CONTOURED_MATERIALS.has(material) && !FIXED_MATERIALS.has(material)) {
      throw new Error(`Terrain ground ${JSON.stringify(semantic)} cannot be contoured.`)
    }
  }
  return { width, height: rows.length }
}

function materialForSemantic(semantic: string): string {
  return semantic === 'bridge' ? 'water' : semantic
}

export function buildCells(
  rows: readonly string[],
  groundNameForCode: Readonly<Record<string, string>>,
  width: number,
  height: number,
): CellRecord[] {
  const cells: CellRecord[] = []
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const code = rows[row]?.[column]
      const semantic = code === undefined ? undefined : groundNameForCode[code]
      if (semantic === undefined)
        throw new Error('Terrain contour cell is missing its ground name.')
      cells.push({
        index: row * width + column,
        column,
        row,
        x: column + 0.5,
        y: row + 0.5,
        semantic,
        material: materialForSemantic(semantic),
      })
    }
  }
  return cells
}

export function buildComponents(cells: readonly CellRecord[]): ComponentRecord[] {
  const groups = connectedComponents(cells, (first, second) => first.material === second.material)
  const records: ComponentRecord[] = groups.map((ordered) => {
    const first = ordered[0]!
    return {
      key: `cell:${first.index}`,
      material: first.material,
      exterior: false,
      cells: ordered,
      id: '',
      outerRingId: '',
      holeRingIds: [],
    } satisfies ComponentRecord
  })
  records.push({
    key: TERRAIN_EXTERIOR,
    material: TERRAIN_EXTERIOR,
    exterior: true,
    cells: [],
    id: '',
    outerRingId: '',
    holeRingIds: [],
  })
  return records.sort(
    (first, second) =>
      first.material.localeCompare(second.material) || first.key.localeCompare(second.key),
  )
}
