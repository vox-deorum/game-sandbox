import type { EdgeCornerDirection, EdgeTreatment, FrameTreatment } from './presentation.js'

/** A configured boundary treatment, expressed in ground-class names. */
export type EdgePairing = EdgeTreatment

export type EdgeMarkKind = 'cardinal' | 'corner' | 'accent'

/** One configured edge mark family placed into the map's packed overlay layers. */
export interface EdgeFamily extends FrameTreatment {
  code: string
  from: string
  to: string
  kind: EdgeMarkKind
  direction?: EdgeCornerDirection
}

/** Immutable, packed terrain overlays prepared before Pixi constructs the tile map. */
export interface EdgePlan {
  layers: readonly (readonly string[])[]
  frameIndexAt: (code: string, column: number, row: number) => number | undefined
  dropped: number
}

const CARDINALS = [[0, -1, 1], [1, 0, 2], [0, 1, 4], [-1, 0, 8]] as const
const CORNERS: Readonly<Record<EdgeCornerDirection, readonly [number, number, number]>> = {
  northEast: [1, -1, 1 | 2],
  southEast: [1, 1, 2 | 4],
  southWest: [-1, 1, 4 | 8],
  northWest: [-1, -1, 8 | 1],
}
const EDGE_CODES = '0123456789ABCDEFGHIJKLMNOQRSTVWXYZ!#$%&()*+,-/:;<=>?@[]^_{|}~'

/**
 * Expand configured pairings into ordered packed-map marks: cardinal boundary, north-east,
 * south-east, south-west, north-west corners, then a bank accent.
 */
export function edgeMarkFamilies(pairings: readonly EdgePairing[]): readonly EdgeFamily[] {
  let index = 0
  const code = (): string => {
    const value = EDGE_CODES[index]
    index += 1
    if (value === undefined) throw new Error('Three Branches presentation has too many edge marks.')
    return value
  }
  return pairings.flatMap((pairing) => {
    const families: EdgeFamily[] = [
      { code: code(), from: pairing.from, to: pairing.to, frames: pairing.frames, tint: pairing.tint, kind: 'cardinal' },
    ]
    if (pairing.corners !== undefined) {
      for (const direction of Object.keys(CORNERS) as EdgeCornerDirection[]) {
        families.push({
          code: code(),
          from: pairing.from,
          to: pairing.to,
          frames: pairing.corners[direction],
          tint: pairing.tint,
          kind: 'corner',
          direction,
        })
      }
    }
    if (pairing.accents !== undefined) {
      families.push({
        code: code(),
        from: pairing.from,
        to: pairing.to,
        frames: pairing.accents,
        tint: pairing.tint,
        kind: 'accent',
      })
    }
    return families
  })
}

/** Plan configured boundaries over a top-first ground grid. Map borders have no implicit outside class. */
export function planEdges(
  rows: readonly string[],
  groundNameForCode: Readonly<Record<string, string>>,
  families: readonly EdgeFamily[],
  layerCount: number,
): EdgePlan {
  const columns = rows[0]?.length ?? 0
  if (columns === 0 || rows.some((row) => row.length !== columns)) {
    throw new Error('Edge planning requires a non-empty rectangular ground grid.')
  }
  if (!Number.isInteger(layerCount) || layerCount <= 0) {
    throw new Error('Edge planning requires at least one overlay layer.')
  }
  const cells = Array.from({ length: layerCount }, () =>
    Array.from({ length: rows.length }, () => ' '.repeat(columns)),
  )
  const frames = new Map<string, number>()
  let dropped = 0
  for (const family of families) {
    for (let row = 0; row < rows.length; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const code = rows[row]?.[column]
        if (code === undefined || groundNameForCode[code] !== family.from) continue
        const mask = boundaryMask(rows, groundNameForCode, column, row, family.to)
        if (!markApplies(rows, groundNameForCode, family, column, row, mask)) continue
        const layer = cells.findIndex((grid) => grid[row]?.[column] === ' ')
        if (layer < 0) {
          dropped += 1
          continue
        }
        const existing = cells[layer]?.[row]
        if (existing === undefined) throw new Error('Edge plan row is missing.')
        cells[layer]![row] = replaceCell(existing, column, family.code)
        frames.set(frameKey(family.code, column, row), frameIndex(family, mask, column, row))
      }
    }
  }
  return {
    layers: cells,
    frameIndexAt: (code, column, row) => frames.get(frameKey(code, column, row)),
    dropped,
  }
}

/** Return the four-bit N/E/S/W boundary mask for a named neighbouring class. */
export function boundaryMask(
  rows: readonly string[],
  groundNameForCode: Readonly<Record<string, string>>,
  column: number,
  row: number,
  to: string,
): number {
  return CARDINALS.reduce((mask, [dx, dy, bit]) => {
    const code = rows[row + dy]?.[column + dx]
    return code !== undefined && groundNameForCode[code] === to ? mask | bit : mask
  }, 0)
}

/** Stable non-cryptographic hash for static art choices. */
export function terrainHash(...parts: readonly (string | number)[]): number {
  let value = 2166136261
  for (const part of parts) {
    for (const character of String(part)) {
      value ^= character.charCodeAt(0)
      value = Math.imul(value, 16777619)
    }
    value ^= 31
    value = Math.imul(value, 16777619)
  }
  return value >>> 0
}

/** Pick a stable frame index without relying on mount or replay history. */
export function terrainVariant(count: number, ...parts: readonly (string | number)[]): number {
  if (!Number.isInteger(count) || count <= 0) throw new Error('Terrain frame count must be positive.')
  return terrainHash(...parts) % count
}

function markApplies(
  rows: readonly string[],
  groundNameForCode: Readonly<Record<string, string>>,
  family: EdgeFamily,
  column: number,
  row: number,
  mask: number,
): boolean {
  if (family.kind === 'cardinal' || family.kind === 'accent') return mask !== 0
  const direction = family.direction
  if (direction === undefined) throw new Error('A corner edge family needs a direction.')
  const [dx, dy, adjacent] = CORNERS[direction]
  const diagonal = rows[row + dy]?.[column + dx]
  return diagonal !== undefined && groundNameForCode[diagonal] === family.to && (mask & adjacent) === 0
}

function frameIndex(family: EdgeFamily, mask: number, column: number, row: number): number {
  if (family.kind === 'cardinal' && family.frames.length === 16) return mask
  return terrainVariant(
    family.frames.length,
    family.from,
    family.to,
    family.kind,
    family.direction ?? '',
    column,
    row,
    mask,
  )
}

function replaceCell(row: string, column: number, code: string): string {
  return `${row.slice(0, column)}${code}${row.slice(column + 1)}`
}

function frameKey(code: string, column: number, row: number): string {
  return `${code}:${column}:${row}`
}
