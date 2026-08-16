import type { GroundTileset, GroundVariant, TileGrid } from '@renderers/base/tiled-ground.js'
import { Texture } from 'pixi.js'

import { THREE_BRANCHES_ASSET_CATALOG } from './assets.js'
import { fillTintHex, HEARTHSIDE_STYLE } from './presentation.js'
import { planTerrainContours } from './terrain-contours.js'
import { terrainVariant } from './terrain-helpers.js'
import { planTerrainRoutes } from './terrain-routes.js'
import { opaqueTintedFillFrame, tintedMaskFrame } from './tint.js'
import type { StaticScene, TerrainContourPlan, TerrainRoutePlan } from './types.js'

export const BRIDGE_PLANK_CODES = {
  horizontal: 'P',
  vertical: 'Y',
  compact: 'Z',
} as const
const UPPER_WALL_CODE = 'U'
const TRANSPARENT_CODE = '.'

/** Cell period of one repeating pattern texture composed from a material's fill frames. */
export const PATTERN_CELLS = 4

/** The materials drawn as anti-aliased vector surfaces with repeating pattern fills. */
export const PATTERN_MATERIALS = ['ground', 'field', 'reeds', 'water', 'road', 'path'] as const

/** Textured static map data resolved once from the terrain atlas and immutable village grid. */
export interface TerrainArt {
  tileset: GroundTileset
  variant: GroundVariant
  patterns: Readonly<Record<string, Texture>>
  contours: TerrainContourPlan
  routes: TerrainRoutePlan
  plankLayer: TileGrid
  upperWallTileset: GroundTileset
  upperWallGrid: TileGrid
  upperWallVariant: GroundVariant
}

/** Bake opaque terrain fills and the exact masks which remain above their vector surfaces. */
export function createTerrainArt(atlas: Texture, scene: StaticScene): TerrainArt {
  const manifest = THREE_BRANCHES_ASSET_CATALOG.find((item) => item.name === 'terrain')
  if (manifest === undefined || 'layers' in manifest)
    throw new Error('Three Branches terrain atlas is missing.')
  const textures: Record<string, readonly Texture[]> = {}
  const counts = new Map<string, number>()
  const names = Object.fromEntries(scene.ground.map((ground) => [ground.code, ground.name]))
  for (const ground of scene.ground) {
    const treatment = HEARTHSIDE_STYLE.terrain.fills[ground.name]
    if (treatment === undefined)
      throw new Error(`Three Branches presentation has no ${ground.name} terrain fill.`)
    textures[ground.code] = fillFramesFor(
      atlas,
      manifest.frames,
      treatment.frames,
      fillTintHex(treatment),
      treatment.detailShift,
    )
    counts.set(ground.code, treatment.frames.length)
  }
  const planks = HEARTHSIDE_STYLE.terrain.planks
  for (const [orientation, code] of Object.entries(BRIDGE_PLANK_CODES)) {
    const frame = planks[orientation as keyof typeof BRIDGE_PLANK_CODES]
    textures[code] = framesFor(atlas, manifest.frames, [frame], planks.tint)
    counts.set(code, 1)
  }
  const patterns: Record<string, Texture> = {}
  for (const material of PATTERN_MATERIALS) {
    const ground = scene.ground.find((item) => item.name === material)
    if (ground === undefined) {
      throw new Error(`Three Branches rules do not define ${material} terrain.`)
    }
    const frames = textures[ground.code]
    if (frames === undefined || frames.length === 0) {
      throw new Error(`Three Branches terrain has no fill frames for ${material}.`)
    }
    const treatment = HEARTHSIDE_STYLE.terrain.fills[material]
    if (treatment === undefined) {
      throw new Error(`Three Branches presentation has no ${material} terrain fill.`)
    }
    patterns[material] = patternTexture(
      frames,
      ground.code,
      manifest.frames.width,
      treatment.offsetPassOpacity,
    )
  }
  const groundTreatment = HEARTHSIDE_STYLE.terrain.fills.ground
  if (groundTreatment === undefined) {
    throw new Error('Three Branches presentation has no ground terrain fill.')
  }
  patterns.ink = patternTexture(
    fillFramesFor(
      atlas,
      manifest.frames,
      groundTreatment.frames,
      HEARTHSIDE_STYLE.palette[HEARTHSIDE_STYLE.terrain.seams.ink.tint],
    ),
    'ink-seam',
    manifest.frames.width,
  )
  const columns = scene.village.size.cellsX
  const routes = planTerrainRoutes(scene.topFirstRows, names, HEARTHSIDE_STYLE.terrain.routes)
  const plankLayer = { columns, rows: plankRowsFor(routes) }
  const variant: GroundVariant = (code, column, row) => {
    const count = counts.get(code)
    if (count === undefined) throw new Error(`Terrain has no frame count for ${code}.`)
    return terrainVariant(count, code, column, row)
  }
  const upperWallTileset: GroundTileset = {
    tileSize: manifest.frames.width,
    textures: {
      [TRANSPARENT_CODE]: Texture.EMPTY,
      [UPPER_WALL_CODE]: framesFor(
        atlas,
        manifest.frames,
        HEARTHSIDE_STYLE.terrain.upperWall.frames,
        HEARTHSIDE_STYLE.terrain.upperWall.tint,
      ),
    },
  }
  const upperWallGrid = {
    columns,
    rows: scene.topFirstRows.map((row) =>
      [...row].map((code) => (names[code] === 'wall' ? UPPER_WALL_CODE : ' ')).join(''),
    ),
  }
  const upperWallVariant: GroundVariant = (code, column, row) =>
    code === UPPER_WALL_CODE
      ? terrainVariant(HEARTHSIDE_STYLE.terrain.upperWall.frames.length, code, column, row)
      : 0
  return {
    tileset: { tileSize: manifest.frames.width, textures },
    variant,
    patterns,
    routes,
    contours: planTerrainContours(
      routes.visualRows,
      names,
      HEARTHSIDE_STYLE.terrain.contours,
      HEARTHSIDE_STYLE.terrain.seams.waterHatch.bridgeTaperCells,
    ),
    plankLayer,
    upperWallTileset,
    upperWallGrid,
    upperWallVariant,
  }
}

/**
 * Compose one repeating pattern canvas from a material's tinted fill frames. Pattern fills wrap
 * the whole texture source, so the pattern must be a standalone canvas, never an atlas view. The
 * variant layout repeats every PATTERN_CELLS cells and stays deterministic per material code.
 *
 * The frames keep calm matching borders, so one aligned layer leaves a faint blank grid on cell
 * boundaries. A second half-cell-offset grain pass can cover those strips and break the grid
 * without touching the atlas art. Wrapped variant indices keep the offset pass seamless across
 * the pattern's own repeat edges. Materials with continuous authored texture can disable it.
 */
function patternTexture(
  frames: readonly Texture[],
  code: string,
  tileSize: number,
  offsetPassOpacity = 0.5,
): Texture {
  const canvas = document.createElement('canvas')
  canvas.width = tileSize * PATTERN_CELLS
  canvas.height = tileSize * PATTERN_CELLS
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('Terrain pattern canvas context is unavailable.')
  const frameAt = (variantCode: string, column: number, row: number): CanvasImageSource => {
    const frame = frames[terrainVariant(frames.length, variantCode, column, row)]
    if (frame === undefined) throw new Error(`Terrain pattern frame for ${code} is missing.`)
    return frame.source.resource as CanvasImageSource
  }
  for (let row = 0; row < PATTERN_CELLS; row += 1) {
    for (let column = 0; column < PATTERN_CELLS; column += 1) {
      context.drawImage(frameAt(code, column, row), column * tileSize, row * tileSize)
    }
  }
  if (offsetPassOpacity > 0) {
    const half = tileSize / 2
    context.globalAlpha = offsetPassOpacity
    for (let row = -1; row < PATTERN_CELLS; row += 1) {
      for (let column = -1; column < PATTERN_CELLS; column += 1) {
        const wrappedColumn = ((column % PATTERN_CELLS) + PATTERN_CELLS) % PATTERN_CELLS
        const wrappedRow = ((row % PATTERN_CELLS) + PATTERN_CELLS) % PATTERN_CELLS
        context.drawImage(
          frameAt(`${code}-offset`, wrappedColumn, wrappedRow),
          column * tileSize + half,
          row * tileSize + half,
        )
      }
    }
  }
  context.globalAlpha = 1
  return Texture.from(canvas)
}

/** Map each planned bridge component to its semantic plank frame without repainting other cells. */
export function plankRowsFor(routes: TerrainRoutePlan): readonly string[] {
  const result = Array.from(
    { length: routes.height },
    () => Array(routes.width).fill(' ') as string[],
  )
  for (const component of routes.bridgeComponents) {
    const code = BRIDGE_PLANK_CODES[component.orientation]
    for (const cell of component.cells) {
      const row = result[cell.row]
      if (row === undefined) throw new Error(`Bridge component ${component.id} leaves its grid.`)
      row[cell.column] = code
    }
  }
  return result.map((row) => row.join(''))
}
/** The transparent base grid under the upper wall overlay. */
export function transparentUpperGrid(columns: number, rows: number): TileGrid {
  return { columns, rows: Array.from({ length: rows }, () => TRANSPARENT_CODE.repeat(columns)) }
}

/** Bake only configured terrain fills as opaque bases. Planks and upper walls stay masks. */
function fillFramesFor(
  atlas: Texture,
  grid: Parameters<typeof tintedMaskFrame>[1],
  frames: readonly string[],
  tintHex: string,
  detailShift?: number,
): readonly Texture[] {
  return frames.map((frame) =>
    opaqueTintedFillFrame(atlas, grid, frame, tintHex, detailShift),
  )
}
/** Bake one semantic mask family. */
function framesFor(
  atlas: Texture,
  grid: Parameters<typeof tintedMaskFrame>[1],
  frames: readonly string[],
  tint: keyof typeof HEARTHSIDE_STYLE.palette,
): readonly Texture[] {
  return frames.map((frame) =>
    tintedMaskFrame(atlas, grid, frame, HEARTHSIDE_STYLE.palette[tint]),
  )
}
