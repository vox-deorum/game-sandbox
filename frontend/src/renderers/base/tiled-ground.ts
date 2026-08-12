/**
 * A small, environment-owned contract for tile ground layers. Environments describe their ground
 * with single-character rows and textures, and this module packs them into one pixi-tiledmap layer.
 * The contract hides that choice, so a renderer never names pixi-tiledmap itself.
 */
import { Container, Texture } from 'pixi.js'
import { createMap, TiledMap } from 'pixi-tiledmap'

/** A row-major grid of one-character ground codes. */
export interface TileGrid {
  /** Number of cells in each row. */
  columns: number
  /** Row-major strings of one-character tile codes. */
  rows: readonly string[]
}

/** The source textures for each ground code. Texture arrays are ordered variant choices. */
export interface GroundTileset {
  /** Source texture edge length in pixels. */
  tileSize: number
  /** One texture or ordered variant textures for each non-empty code. */
  textures: Readonly<Record<string, Texture | readonly Texture[]>>
}

/** The reserved empty code for optional layers. The base grid may not use it. */
export const EMPTY_TILE_CODE = ' '

/**
 * A callback that chooses a zero-based texture variant for one grid cell. The final argument is an
 * eight-bit mask of same-code neighbours: N 1, NE 2, E 4, SE 8, S 16, SW 32, W 64, NW 128.
 */
export type GroundVariant = (
  code: string,
  column: number,
  row: number,
  neighbourMask: number,
) => number

/** The dimensions of a ground layer in world units. */
export interface GroundSpan {
  /** Drawn width in renderer world units. */
  width: number
  /** Drawn height in renderer world units. */
  height: number
}

/** How large each cell is drawn, and which texture variant a cell takes. */
export interface TiledGroundOptions {
  /** Drawn edge length of one cell in renderer world units. */
  cellSize: number
  /** Optional deterministic texture-variant selector. */
  variant?: GroundVariant
  /** Ordered grids painted over the base. A space leaves an overlay cell transparent. */
  layers?: readonly TileGrid[]
}

/** The public, project-owned ground layer. */
export interface TiledGround {
  /** Container holding the single packed tiled map. */
  view: Container
  /** Drawn base-grid extent. */
  span: GroundSpan
  /** Repaint one base-grid cell. */
  setTile(column: number, row: number, code: string): void
  /** Release the packed map and its container. */
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
    if (code === EMPTY_TILE_CODE) {
      throw new Error('GroundTileset code " " is reserved for empty overlay cells.')
    }
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
      if (code === EMPTY_TILE_CODE || !(code in tileset.textures)) {
        throw new Error(`TileGrid code "${code}" at ${column}, ${row} is not in the GroundTileset.`)
      }
    }
  }
}

/** Validate optional grids that share the base dimensions and may use the reserved empty code. */
export function validateGroundLayers(
  grid: TileGrid,
  layers: readonly TileGrid[],
  tileset: GroundTileset,
): void {
  validateGroundGrid(grid, tileset)
  for (const [index, layer] of layers.entries()) {
    validateTileGrid(layer)
    if (layer.columns !== grid.columns || layer.rows.length !== grid.rows.length) {
      throw new Error(`Ground layer ${index} must match the base grid dimensions.`)
    }
    for (const [row, codes] of layer.rows.entries()) {
      for (const [column, code] of [...codes].entries()) {
        if (code !== EMPTY_TILE_CODE && !(code in tileset.textures)) {
          throw new Error(
            `Ground layer ${index} code "${code}" at ${column}, ${row} is not in the GroundTileset.`,
          )
        }
      }
    }
  }
}

/** Return the clockwise, north-first mask of neighbours that share one cell's code. */
export function groundNeighbourMask(grid: TileGrid, column: number, row: number): number {
  const code = grid.rows[row]?.[column]
  if (code === undefined || code === EMPTY_TILE_CODE) return 0
  const neighbours = [
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
  ] as const
  return neighbours.reduce(
    (mask, [dx, dy], bit) =>
      grid.rows[row + dy]?.[column + dx] === code ? mask | (1 << bit) : mask,
    0,
  )
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
  neighbourMask = 0,
): Texture {
  validateGroundTileset(tileset)
  const source = tileset.textures[code]
  if (source === undefined) {
    throw new Error(`Unknown ground code "${code}".`)
  }
  const textures = Array.isArray(source) ? source : [source]
  const index = variant?.(code, column, row, neighbourMask) ?? 0
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
  { cellSize, variant, layers = [] }: TiledGroundOptions,
): TiledGround {
  validateGroundLayers(grid, layers, tileset)
  const span = tileGridSpan(grid, cellSize)
  const view = new Container()
  const baseRows = [...grid.rows]
  const baseGrid = (): TileGrid => ({ columns: grid.columns, rows: baseRows })
  const textureAt = (source: TileGrid, code: string, column: number, row: number): Texture =>
    selectGroundTexture(
      tileset,
      code,
      column,
      row,
      variant,
      groundNeighbourMask(source, column, row),
    )
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
  const tileIdAt = (source: TileGrid, code: string, column: number, row: number): number =>
    tileIdFor(textureAt(source, code, column, row))
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
      // One TiledMap keeps the base and its ordered overlays on the same packed drawing path.
      layers: [
        tileLayer('ground', baseGrid(), false, tileIdAt),
        ...layers.map((layer, index) => tileLayer(`layer-${index}`, layer, true, tileIdAt)),
      ],
    }),
    { tileImageTextures: images, tileSpritePadding: 0 },
  )
  map.scale.set(cellSize / tileset.tileSize)
  view.addChild(map)
  return groundLifecycle(view, grid, span, (column, row, code) => {
    // The public mutator belongs to the base only. Its new code changes the target's autotile mask.
    if (code === EMPTY_TILE_CODE || !(code in tileset.textures)) {
      throw new Error(`Unknown ground code "${code}".`)
    }
    const rowCodes = baseRows[row]
    if (rowCodes === undefined)
      throw new Error(`Tile position ${column}, ${row} is outside the ground.`)
    baseRows[row] = `${rowCodes.slice(0, column)}${code}${rowCodes.slice(column + 1)}`
    const source = baseGrid()
    map.setTile('ground', column, row, {
      tileset: 'ground',
      tileId: tileIdAt(source, code, column, row),
    })
  })
}

function tileLayer(
  name: string,
  grid: TileGrid,
  allowsEmpty: boolean,
  tileIdAt: (grid: TileGrid, code: string, column: number, row: number) => number,
): {
  name: string
  width: number
  height: number
  tiles: ({ tileset: string; tileId: number } | null)[]
} {
  return {
    name,
    width: grid.columns,
    height: grid.rows.length,
    tiles: grid.rows.flatMap((codes, row) =>
      [...codes].map((code, column) =>
        allowsEmpty && code === EMPTY_TILE_CODE
          ? null
          : { tileset: 'ground', tileId: tileIdAt(grid, code, column, row) },
      ),
    ),
  }
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
