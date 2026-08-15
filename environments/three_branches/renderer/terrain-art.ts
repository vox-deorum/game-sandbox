import type { GroundTileset, GroundVariant, TileGrid } from '@renderers/base/tiled-ground.js'
import { Texture } from 'pixi.js'

import { THREE_BRANCHES_ASSET_CATALOG } from './assets.js'
import { HEARTHSIDE_STYLE } from './presentation.js'
import { planTerrainContours, type TerrainContourPlan, terrainVariant } from './terrain-contours.js'
import { planTerrainRoutes, type TerrainRoutePlan } from './terrain-routes.js'
import { opaqueTintedFillFrame, tintedMaskFrame } from './tint.js'
import type { StaticScene } from './types.js'

export const BRIDGE_PLANK_CODES = {
  horizontal: 'P',
  vertical: 'Y',
  compact: 'Z',
} as const
const UPPER_WALL_CODE = 'U'
const TRANSPARENT_CODE = '.'

/** Textured static map data resolved once from the terrain atlas and immutable village grid. */
export interface TerrainArt {
  tileset: GroundTileset
  variant: GroundVariant
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
    textures[ground.code] = fillFramesFor(atlas, manifest.frames, treatment.frames, treatment.tint)
    counts.set(ground.code, treatment.frames.length)
  }
  const planks = HEARTHSIDE_STYLE.terrain.planks
  for (const [orientation, code] of Object.entries(BRIDGE_PLANK_CODES)) {
    const frame = planks[orientation as keyof typeof BRIDGE_PLANK_CODES]
    textures[code] = framesFor(atlas, manifest.frames, [frame], planks.tint)
    counts.set(code, 1)
  }
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
    routes,
    contours: planTerrainContours(
      routes.visualRows,
      names,
      HEARTHSIDE_STYLE.terrain.contours,
      HEARTHSIDE_STYLE.terrain.contours.shoreline.bridgeTaperCells,
    ),
    plankLayer,
    upperWallTileset,
    upperWallGrid,
    upperWallVariant,
  }
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
  tint: keyof typeof HEARTHSIDE_STYLE.palette,
): readonly Texture[] {
  return frames.map((frame) =>
    opaqueTintedFillFrame(atlas, grid, frame, HEARTHSIDE_STYLE.palette[tint]),
  )
}
/** Bake one semantic mask family. */
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
