import type { GroundTileset, GroundVariant, TileGrid } from '@renderers/base/tiled-ground.js'
import { Texture } from 'pixi.js'

import { THREE_BRANCHES_ASSET_CATALOG } from './assets.js'
import { edgeMarkFamilies, planEdges, terrainVariant } from './edges.js'
import { HEARTHSIDE_STYLE } from './presentation.js'
import { opaqueTintedFillFrame, tintedMaskFrame } from './tint.js'
import type { StaticScene } from './types.js'

const PLANK_CODE = 'P'
const UPPER_WALL_CODE = 'U'
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
  for (const ground of scene.ground) {
    const treatment = HEARTHSIDE_STYLE.terrain.fills[ground.name]
    if (treatment === undefined) throw new Error(`Three Branches presentation has no ${ground.name} terrain fill.`)
    textures[ground.code] = fillFramesFor(atlas, manifest.frames, treatment.frames, treatment.tint)
    counts.set(ground.code, treatment.frames.length)
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
  textures[PLANK_CODE] = framesFor(atlas, manifest.frames, HEARTHSIDE_STYLE.terrain.planks.frames, HEARTHSIDE_STYLE.terrain.planks.tint)
  counts.set(PLANK_CODE, HEARTHSIDE_STYLE.terrain.planks.frames.length)
  const names = Object.fromEntries(scene.ground.map((ground) => [ground.code, ground.name]))
  const edgePlan = planEdges(scene.topFirstRows, names, families, HEARTHSIDE_STYLE.terrain.edges.layers)
  const columns = scene.village.size.cellsX
  const plankLayer = { columns, rows: plankRowsFor(scene.topFirstRows, names) }
  const variant: GroundVariant = (code, column, row) => {
    const edgeFrame = edgePlan.frameIndexAt(code, column, row)
    if (edgeFrame !== undefined) return edgeFrame
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

/** Plan bridge planks on bridge cells only, independent from their fill treatment. */
export function plankRowsFor(
  rows: readonly string[],
  groundNameForCode: Readonly<Record<string, string>>,
): readonly string[] {
  return rows.map((row) =>
    [...row].map((code) => (groundNameForCode[code] === 'bridge' ? PLANK_CODE : ' ')).join(''),
  )
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
