import type { GroundTileset, GroundVariant, TileGrid } from '@renderers/base/tiled-ground.js'
import { Texture } from 'pixi.js'

import { THREE_BRANCHES_ASSET_CATALOG } from './assets.js'
import {
  cutoutVariant,
  edgeMarkFamilies,
  planEdges,
  RESERVED_TERRAIN_CODES,
  terrainVariant,
} from './edges.js'
import {
  HEARTHSIDE_STYLE,
  type CutoutEdgeTreatment,
} from './presentation.js'
import { cutoutTintedFillFrame, opaqueTintedFillFrame, tintedMaskFrame } from './tint.js'
import type { StaticScene } from './types.js'

export const BRIDGE_PLANK_CODES = {
  horizontal: RESERVED_TERRAIN_CODES.bridgeHorizontal,
  vertical: RESERVED_TERRAIN_CODES.bridgeVertical,
  compact: RESERVED_TERRAIN_CODES.bridgeCompact,
} as const
const UPPER_WALL_CODE = RESERVED_TERRAIN_CODES.upperWall
const TRANSPARENT_CODE = '.'

/** Textured static map data resolved once from the terrain atlas and immutable village grid. */
export interface TerrainArt {
  tileset: GroundTileset
  variant: GroundVariant
  edgeLayers: readonly TileGrid[]
  plankLayer: TileGrid
  upperWallTileset: GroundTileset
  upperWallGrid: TileGrid
  upperWallVariant: GroundVariant
  droppedEdges: number
}

/** Bake configured terrain frames and prepare its deterministic packed grid layers. */
export function createTerrainArt(atlas: Texture, scene: StaticScene): TerrainArt {
  const manifest = THREE_BRANCHES_ASSET_CATALOG.find((item) => item.name === 'terrain')
  if (manifest === undefined || 'layers' in manifest) throw new Error('Three Branches terrain atlas is missing.')
  const textures: Record<string, readonly Texture[]> = {}
  const counts = new Map<string, number>()
  const names = Object.fromEntries(scene.ground.map((ground) => [ground.code, ground.name]))
  const cutoutsByCode = new Map<
    string,
    { treatment: CutoutEdgeTreatment; detailCount: number }
  >()
  for (const ground of scene.ground) {
    const treatment = HEARTHSIDE_STYLE.terrain.fills[ground.name]
    if (treatment === undefined) throw new Error(`Three Branches presentation has no ${ground.name} terrain fill.`)
    const cutout = HEARTHSIDE_STYLE.terrain.edges.pairings.find(
      (pairing): pairing is CutoutEdgeTreatment =>
        pairing.mode === 'cutout' && pairing.from === ground.name,
    )
    if (cutout === undefined) {
      textures[ground.code] = fillFramesFor(
        atlas,
        manifest.frames,
        treatment.frames,
        treatment.tint,
      )
      counts.set(ground.code, treatment.frames.length)
    } else {
      textures[ground.code] = cutoutFillFramesFor(
        atlas,
        manifest.frames,
        treatment.frames,
        treatment.tint,
        cutout.frames,
      )
      counts.set(ground.code, treatment.frames.length * cutout.frames.length)
      cutoutsByCode.set(ground.code, { treatment: cutout, detailCount: treatment.frames.length })
    }
  }
  const families = edgeMarkFamilies(HEARTHSIDE_STYLE.terrain.edges.pairings)
  for (const family of families) {
    textures[family.code] = framesFor(
      atlas,
      manifest.frames,
      family.frames,
      family.tint,
      family.opacity,
    )
  }
  const planks = HEARTHSIDE_STYLE.terrain.planks
  for (const [orientation, code] of Object.entries(BRIDGE_PLANK_CODES)) {
    const frame = planks[orientation as keyof typeof BRIDGE_PLANK_CODES]
    textures[code] = framesFor(atlas, manifest.frames, [frame], planks.tint)
    counts.set(code, 1)
  }
  const edgePlan = planEdges(scene.topFirstRows, names, families, HEARTHSIDE_STYLE.terrain.edges.layers)
  const columns = scene.village.size.cellsX
  const plankLayer = { columns, rows: plankRowsFor(scene.topFirstRows, names) }
  const variant: GroundVariant = (code, column, row) => {
    const edgeFrame = edgePlan.frameIndexAt(code, column, row)
    if (edgeFrame !== undefined) return edgeFrame
    const cutout = cutoutsByCode.get(code)
    if (cutout !== undefined) {
      return cutoutVariant(
        scene.topFirstRows,
        names,
        cutout.treatment,
        column,
        row,
        cutout.detailCount,
      )
    }
    const count = counts.get(code)
    if (count === undefined) throw new Error(`Terrain has no frame count for ${code}.`)
    return terrainVariant(count, code, column, row)
  }
  const upperWallTileset: GroundTileset = {
    tileSize: manifest.frames.width,
    textures: {
      [TRANSPARENT_CODE]: Texture.EMPTY,
      [UPPER_WALL_CODE]: framesFor(atlas, manifest.frames, HEARTHSIDE_STYLE.terrain.upperWall.frames, HEARTHSIDE_STYLE.terrain.upperWall.tint),
    },
  }
  const upperWallGrid = {
    columns,
    rows: scene.topFirstRows.map((row) => [...row].map((code) => (names[code] === 'wall' ? UPPER_WALL_CODE : ' ')).join('')),
  }
  const upperWallVariant: GroundVariant = (code, column, row) =>
    code === UPPER_WALL_CODE ? terrainVariant(HEARTHSIDE_STYLE.terrain.upperWall.frames.length, code, column, row) : 0
  return {
    tileset: { tileSize: manifest.frames.width, textures },
    variant,
    edgeLayers: edgePlan.layers.map((rows) => ({ columns, rows })),
    plankLayer,
    upperWallTileset,
    upperWallGrid,
    upperWallVariant,
    droppedEdges: edgePlan.dropped,
  }
}

/** Plan one semantic deck orientation for every cardinally connected bridge component. */
export function plankRowsFor(
  rows: readonly string[],
  groundNameForCode: Readonly<Record<string, string>>,
): readonly string[] {
  const columns = rows[0]?.length ?? 0
  if (columns === 0 || rows.some((row) => row.length !== columns)) {
    throw new Error('Bridge planning requires a non-empty rectangular ground grid.')
  }
  const result = Array.from({ length: rows.length }, () => Array(columns).fill(' ') as string[])
  const visited = Array.from({ length: rows.length }, () => Array(columns).fill(false) as boolean[])
  const directions = [
    [0, -1, 'north'],
    [1, 0, 'east'],
    [0, 1, 'south'],
    [-1, 0, 'west'],
  ] as const
  for (let startRow = 0; startRow < rows.length; startRow += 1) {
    for (let startColumn = 0; startColumn < columns; startColumn += 1) {
      const startCode = rows[startRow]?.[startColumn]
      if (
        startCode === undefined ||
        groundNameForCode[startCode] !== 'bridge' ||
        visited[startRow]?.[startColumn]
      ) {
        continue
      }
      const component: [number, number][] = []
      const queue: [number, number][] = [[startColumn, startRow]]
      visited[startRow]![startColumn] = true
      for (let index = 0; index < queue.length; index += 1) {
        const cell = queue[index]
        if (cell === undefined) continue
        const [column, row] = cell
        component.push(cell)
        for (const [dx, dy] of directions) {
          const nextColumn = column + dx
          const nextRow = row + dy
          const nextCode = rows[nextRow]?.[nextColumn]
          if (
            nextCode === undefined ||
            groundNameForCode[nextCode] !== 'bridge' ||
            visited[nextRow]?.[nextColumn]
          ) {
            continue
          }
          visited[nextRow]![nextColumn] = true
          queue.push([nextColumn, nextRow])
        }
      }
      const orientation = bridgeOrientation(component, rows, groundNameForCode, directions)
      const code = BRIDGE_PLANK_CODES[orientation]
      for (const [column, row] of component) result[row]![column] = code
    }
  }
  return result.map((row) => row.join(''))
}

type BridgeOrientation = keyof typeof BRIDGE_PLANK_CODES

function bridgeOrientation(
  component: readonly (readonly [number, number])[],
  rows: readonly string[],
  groundNameForCode: Readonly<Record<string, string>>,
  directions: readonly (readonly [number, number, 'north' | 'east' | 'south' | 'west'])[],
): BridgeOrientation {
  const contacts = { north: 0, east: 0, south: 0, west: 0 }
  let minColumn = Number.POSITIVE_INFINITY
  let maxColumn = Number.NEGATIVE_INFINITY
  let minRow = Number.POSITIVE_INFINITY
  let maxRow = Number.NEGATIVE_INFINITY
  for (const [column, row] of component) {
    minColumn = Math.min(minColumn, column)
    maxColumn = Math.max(maxColumn, column)
    minRow = Math.min(minRow, row)
    maxRow = Math.max(maxRow, row)
    for (const [dx, dy, side] of directions) {
      const neighbor = rows[row + dy]?.[column + dx]
      const name = neighbor === undefined ? undefined : groundNameForCode[neighbor]
      if (name === 'road' || name === 'path') contacts[side] += 1
    }
  }
  const horizontalPair = contacts.east > 0 && contacts.west > 0
  const verticalPair = contacts.north > 0 && contacts.south > 0
  if (horizontalPair !== verticalPair) return horizontalPair ? 'horizontal' : 'vertical'
  const horizontalContacts = contacts.east + contacts.west
  const verticalContacts = contacts.north + contacts.south
  if (horizontalContacts !== verticalContacts) {
    return horizontalContacts > verticalContacts ? 'horizontal' : 'vertical'
  }
  const horizontalSpan = maxColumn - minColumn + 1
  const verticalSpan = maxRow - minRow + 1
  if (horizontalSpan !== verticalSpan) return horizontalSpan > verticalSpan ? 'horizontal' : 'vertical'
  return 'compact'
}
/** The transparent base grid under the upper wall overlay. */
export function transparentUpperGrid(columns: number, rows: number): TileGrid {
  return { columns, rows: Array.from({ length: rows }, () => TRANSPARENT_CODE.repeat(columns)) }
}

/** Bake only configured terrain fills as opaque bases. Edges, planks, and upper walls stay masks. */
function fillFramesFor(
  atlas: Texture,
  grid: Parameters<typeof tintedMaskFrame>[1],
  frames: readonly string[],
  tint: keyof typeof HEARTHSIDE_STYLE.palette,
): readonly Texture[] {
  return frames.map((frame) =>
    opaqueTintedFillFrame(atlas, grid, frame, HEARTHSIDE_STYLE.palette[tint]),
  )
}
/** Bake each cardinal mask group with every fill detail in mask-major order. */
function cutoutFillFramesFor(
  atlas: Texture,
  grid: Parameters<typeof tintedMaskFrame>[1],
  fillFrames: readonly string[],
  tint: keyof typeof HEARTHSIDE_STYLE.palette,
  maskFrames: readonly string[],
): readonly Texture[] {
  return maskFrames.flatMap((mask) =>
    fillFrames.map((fill) =>
      cutoutTintedFillFrame(atlas, grid, fill, HEARTHSIDE_STYLE.palette[tint], mask),
    ),
  )
}
/** Bake one terrain mask family at its configured opacity. */
function framesFor(
  atlas: Texture,
  grid: Parameters<typeof tintedMaskFrame>[1],
  frames: readonly string[],
  tint: keyof typeof HEARTHSIDE_STYLE.palette,
  opacity = 1,
): readonly Texture[] {
  return frames.map((frame) =>
    tintedMaskFrame(atlas, grid, frame, HEARTHSIDE_STYLE.palette[tint], opacity),
  )
}
