/**
 * A small, environment-owned contract for tile ground layers. Environments describe their ground
 * with single-character rows and textures, and this module packs them into one pixi-tiledmap layer.
 * The contract hides that choice, so a renderer never names pixi-tiledmap itself.
 */
import { Container, Texture } from 'pixi.js'
import { createMap, TiledMap } from 'pixi-tiledmap'

/** A row-major grid of one-character ground codes. */
export interface TileGrid {
  columns: number
  rows: readonly string[]
}

/** The source textures for each ground code. Texture arrays are ordered variant choices. */
export interface GroundTileset {
  tileSize: number
  textures: Readonly<Record<string, Texture | readonly Texture[]>>
}

/** A callback that chooses a zero-based texture variant for one grid cell. */
export type GroundVariant = (code: string, column: number, row: number) => number

/** The dimensions of a ground layer in world units. */
export interface GroundSpan {
  width: number
  height: number
}

/** How large each cell is drawn, and which texture variant a cell takes. */
export interface TiledGroundOptions {
  cellSize: number
  variant?: GroundVariant
}

/** The public, project-owned ground layer. */
export interface TiledGround {
  view: Container
  span: GroundSpan
  setTile(column: number, row: number, code: string): void
  destroy(): void
}

/** Validate grid shape without constructing Pixi display objects. */
export function validateTileGrid(grid: TileGrid): void {
  if (!Number.isInteger(grid.columns) || grid.columns <= 0) {
    throw new Error('TileGrid columns must be a positive integer.')
  }
  if (grid.rows.length === 0) {
    throw new Error('TileGrid must contain at least one row.')
  }
  for (const [row, codes] of grid.rows.entries()) {
    if (codes.length !== grid.columns) {
      throw new Error(`TileGrid row ${row} has ${codes.length} columns; expected ${grid.columns}.`)
    }
  }
}

/** Validate tileset shape without asking Pixi to upload or draw a texture. */
export function validateGroundTileset(tileset: GroundTileset): void {
  if (!Number.isFinite(tileset.tileSize) || tileset.tileSize <= 0) {
    throw new Error('GroundTileset tileSize must be a positive number.')
  }
  for (const [code, source] of Object.entries(tileset.textures)) {
    if (code.length !== 1) {
      throw new Error(`GroundTileset code "${code}" must be one character.`)
    }
    if (Array.isArray(source) && source.length === 0) {
      throw new Error(`GroundTileset code "${code}" must provide at least one texture.`)
    }
  }
}

/** Validate that every grid code is backed by a tileset texture. */
export function validateGroundGrid(grid: TileGrid, tileset: GroundTileset): void {
  validateTileGrid(grid)
  validateGroundTileset(tileset)
  for (const [row, codes] of grid.rows.entries()) {
    for (const [column, code] of [...codes].entries()) {
      if (!(code in tileset.textures)) {
        throw new Error(`TileGrid code "${code}" at ${column}, ${row} is not in the GroundTileset.`)
      }
    }
  }
}

/** Return the layer span after checking the grid and requested cell size. */
export function tileGridSpan(grid: TileGrid, cellSize: number): GroundSpan {
  validateTileGrid(grid)
  validateCellSize(cellSize)
  return { width: grid.columns * cellSize, height: grid.rows.length * cellSize }
}

/** Resolve a code to one deterministic texture without creating display objects. */
export function selectGroundTexture(
  tileset: GroundTileset,
  code: string,
  column: number,
  row: number,
  variant?: GroundVariant,
): Texture {
  validateGroundTileset(tileset)
  const source = tileset.textures[code]
  if (source === undefined) {
    throw new Error(`Unknown ground code "${code}".`)
  }
  const textures = Array.isArray(source) ? source : [source]
  const index = variant?.(code, column, row) ?? 0
  if (!Number.isInteger(index) || index < 0 || index >= textures.length) {
    throw new Error(
      `Ground variant for "${code}" at ${column}, ${row} is outside its texture range.`,
    )
  }
  return textures[index]
}

/**
 * Create flat-color textures without external assets. The one-pixel tiles are scaled by
 * {@link createTiledGround}, so a color tileset stays compact regardless of the cell size.
 */
export function solidColorTileset(colors: Readonly<Record<string, string>>): GroundTileset {
  const tileSize = 1
  const textures: Record<string, Texture> = {}
  for (const [code, color] of Object.entries(colors)) {
    if (code.length !== 1) {
      throw new Error(`GroundTileset code "${code}" must be one character.`)
    }
    const canvas = document.createElement('canvas')
    canvas.width = tileSize
    canvas.height = tileSize
    const context = canvas.getContext('2d')
    if (context === null) {
      throw new Error('A 2D canvas is required to create solid-color ground textures.')
    }
    context.fillStyle = color
    context.fillRect(0, 0, tileSize, tileSize)
    textures[code] = Texture.from(canvas)
  }
  return { tileSize, textures }
}

/** Draw a grid as one packed pixi-tiledmap layer. Validation completes before any drawing. */
export function createTiledGround(
  grid: TileGrid,
  tileset: GroundTileset,
  { cellSize, variant }: TiledGroundOptions,
): TiledGround {
  validateGroundGrid(grid, tileset)
  const span = tileGridSpan(grid, cellSize)
  const view = new Container()
  const textureAt = (code: string, column: number, row: number): Texture =>
    selectGroundTexture(tileset, code, column, row, variant)
  const ids = new Map<Texture, number>()
  const images = new Map<string, Texture>()
  const tiles: { id: number; image: string; imagewidth: number; imageheight: number }[] = []
  let nextId = 0
  const tileIdFor = (texture: Texture): number => {
    const existing = ids.get(texture)
    if (existing !== undefined) return existing
    const id = nextId++
    ids.set(texture, id)
    const image = `ground-${id}`
    images.set(image, texture)
    tiles.push({ id, image, imagewidth: tileset.tileSize, imageheight: tileset.tileSize })
    return id
  }
  const tileIdAt = (code: string, column: number, row: number): number =>
    tileIdFor(textureAt(code, column, row))
  for (const source of Object.values(tileset.textures)) {
    for (const texture of Array.isArray(source) ? source : [source]) {
      tileIdFor(texture)
    }
  }
  const map = new TiledMap(
    createMap({
      width: grid.columns,
      height: grid.rows.length,
      tilewidth: tileset.tileSize,
      tileheight: tileset.tileSize,
      tilesets: [
        {
          name: 'ground',
          tilewidth: tileset.tileSize,
          tileheight: tileset.tileSize,
          tilecount: nextId,
          tiles,
        },
      ],
      layers: [
        {
          name: 'ground',
          width: grid.columns,
          height: grid.rows.length,
          tiles: grid.rows.flatMap((codes, row) =>
            [...codes].map((code, column) => ({
              tileset: 'ground',
              tileId: tileIdAt(code, column, row),
            })),
          ),
        },
      ],
    }),
    { tileImageTextures: images, tileSpritePadding: 0 },
  )
  map.scale.set(cellSize / tileset.tileSize)
  view.addChild(map)
  return groundLifecycle(view, grid, span, (column, row, code) => {
    map.setTile('ground', column, row, { tileset: 'ground', tileId: tileIdAt(code, column, row) })
  })
}

function groundLifecycle(
  view: Container,
  grid: TileGrid,
  span: GroundSpan,
  repaint: (column: number, row: number, code: string) => void,
): TiledGround {
  let destroyed = false
  return {
    view,
    span,
    setTile(column, row, code) {
      if (destroyed) throw new Error('Cannot repaint a destroyed tiled ground.')
      if (
        !Number.isInteger(column) ||
        !Number.isInteger(row) ||
        column < 0 ||
        row < 0 ||
        column >= grid.columns ||
        row >= grid.rows.length
      ) {
        throw new Error(`Tile position ${column}, ${row} is outside the ground.`)
      }
      repaint(column, row, code)
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      view.destroy({ children: true })
    },
  }
}

function validateCellSize(cellSize: number): void {
  if (!Number.isFinite(cellSize) || cellSize <= 0) {
    throw new Error('Tiled ground cellSize must be a positive number.')
  }
}
