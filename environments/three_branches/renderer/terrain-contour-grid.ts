import { shapeTerrainCurve } from './terrain-curves.js'
import { cellAt, compareCells, connectedComponents, terrainVariant } from './terrain-helpers.js'
import type {
  TerrainContourCell,
  TerrainContourSettings,
  TerrainCurveSourcePoint,
  TerrainSaddle,
} from './types.js'
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

/** A deterministic resolution of an ambiguous four-cell saddle. */
export interface SaddleRecord extends TerrainSaddle {
  readonly winnerCells: readonly CellRecord[]
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
  settings: TerrainContourSettings,
  bridgeTaperCells: number,
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
  validateCurveProfiles(settings.profiles)
  if (!(settings.junctionTangentCells >= 0 && settings.junctionTangentCells <= 0.5)) {
    throw new Error('Contour junction tangent must be between zero and 0.5 cell.')
  }
  if (!(settings.maxDeviationCells > 0 && settings.maxDeviationCells <= 0.75)) {
    throw new Error('Contour maximum deviation must be greater than zero and at most 0.75 cell.')
  }
  if (!(settings.minimumCorridorCells >= 0.7 && settings.minimumCorridorCells <= 1)) {
    throw new Error('Contour minimum corridor must be between 0.70 and one cell.')
  }
  if (!(settings.saddleRadiusCells > 0 && settings.saddleRadiusCells <= 0.08)) {
    throw new Error('Contour saddle radius must be greater than zero and at most 0.08 cell.')
  }
  if (!Number.isFinite(bridgeTaperCells) || bridgeTaperCells < 0 || bridgeTaperCells > 1) {
    throw new Error('Bridge shoreline taper must be between zero and one cell.')
  }
  return { width, height: rows.length }
}

function validateCurveProfiles(profiles: TerrainContourSettings['profiles']): void {
  const source: readonly TerrainCurveSourcePoint[] = [
    { x: 0, y: 0, locked: true },
    { x: 1, y: 0, locked: true },
  ]
  for (const [name, profile] of [
    ['land', profiles.land],
    ['water', profiles.water],
  ] as const) {
    try {
      shapeTerrainCurve(source, false, profile, 0)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Contour ${name} profile is invalid: ${message}`)
    }
  }
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

export function findSaddles(
  cells: readonly CellRecord[],
  width: number,
  height: number,
  radius: number,
): SaddleRecord[] {
  const saddles: SaddleRecord[] = []
  for (let y = 1; y < height; y += 1) {
    for (let x = 1; x < width; x += 1) {
      const northWest = cellAt(cells, width, height, x - 1, y - 1)!
      const northEast = cellAt(cells, width, height, x, y - 1)!
      const southEast = cellAt(cells, width, height, x, y)!
      const southWest = cellAt(cells, width, height, x - 1, y)!
      if (
        northWest.material !== southEast.material ||
        northEast.material !== southWest.material ||
        northWest.material === northEast.material
      ) {
        continue
      }
      const materials = [northWest.material, northEast.material].sort() as [string, string]
      const winner = materials[terrainVariant(2, 'terrain-saddle', x, y, ...materials)]!
      const winnerCells =
        winner === northWest.material ? [northWest, southEast] : [northEast, southWest]
      saddles.push({ x, y, materials, winner, radius, winnerCells })
    }
  }
  return saddles
}

export function buildComponents(
  cells: readonly CellRecord[],
  saddles: readonly SaddleRecord[],
): ComponentRecord[] {
  const groups = connectedComponents(
    cells,
    (first, second) => first.material === second.material,
    saddles.map(({ winnerCells }) => [winnerCells[0]!, winnerCells[1]!] as const),
  )
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
