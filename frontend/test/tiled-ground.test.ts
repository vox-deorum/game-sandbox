import { Texture } from 'pixi.js'
import { describe, expect, it, vi } from 'vitest'

import {
  createSparseTiledGround,
  createTiledGround,
  EMPTY_TILE_CODE,
  type GroundTileset,
  groundNeighbourMask,
  selectGroundTexture,
  tileGridSpan,
  validateGroundGrid,
  validateGroundLayers,
  validateGroundTileset,
  validateTileGrid,
} from '../src/renderers/base/tiled-ground.js'

const textureA = {} as Texture
const textureB = {} as Texture
const tileset: GroundTileset = {
  tileSize: 1,
  textures: { a: textureA, b: [textureA, textureB] },
}

describe('tiled ground validation', () => {
  it('requires a rectangular, non-empty row-major grid', () => {
    expect(() => validateTileGrid({ columns: 0, rows: ['a'] })).toThrow('positive integer')
    expect(() => validateTileGrid({ columns: 1, rows: [] })).toThrow('at least one row')
    expect(() => validateTileGrid({ columns: 2, rows: ['a'] })).toThrow('expected 2')
  })

  it('requires one-character codes and at least one texture per code', () => {
    expect(() => validateGroundTileset({ tileSize: 0, textures: {} })).toThrow('positive number')
    expect(() => validateGroundTileset({ tileSize: 1, textures: { grass: textureA } })).toThrow(
      'one character',
    )
    expect(() => validateGroundTileset({ tileSize: 1, textures: { a: [] } })).toThrow(
      'at least one texture',
    )
    expect(() => validateGroundTileset({ tileSize: 1, textures: { ' ': textureA } })).toThrow(
      'reserved',
    )
  })

  it('rejects grid codes that have no tileset texture', () => {
    expect(() => validateGroundGrid({ columns: 2, rows: ['az'] }, tileset)).toThrow('"z"')
  })

  it('requires overlay layers to match the base and reserves space as their empty code', () => {
    const base = { columns: 2, rows: ['aa'] }
    expect(() => validateGroundGrid({ columns: 1, rows: [EMPTY_TILE_CODE] }, tileset)).toThrow(
      '" "',
    )
    expect(() => validateGroundLayers(base, [{ columns: 1, rows: ['a'] }], tileset)).toThrow(
      'match the base',
    )
    expect(() => validateGroundLayers(base, [{ columns: 2, rows: [' z'] }], tileset)).toThrow('"z"')
    expect(() =>
      validateGroundLayers(base, [{ columns: 2, rows: [`a${EMPTY_TILE_CODE}`] }], tileset),
    ).not.toThrow()
  })
})

describe('tiled ground selection', () => {
  it('calculates the ground span from cell count and cell size', () => {
    expect(tileGridSpan({ columns: 3, rows: ['aaa', 'aaa'] }, 16)).toEqual({
      width: 48,
      height: 32,
    })
  })

  it('uses the first texture by default and a deterministic selected variant when supplied', () => {
    expect(selectGroundTexture(tileset, 'b', 3, 4)).toBe(textureA)
    const checkerboard = (_code: string, column: number, row: number) => (column + row) % 2
    expect(selectGroundTexture(tileset, 'b', 2, 2, checkerboard)).toBe(textureA)
    expect(selectGroundTexture(tileset, 'b', 2, 3, checkerboard)).toBe(textureB)
  })

  it('passes the clockwise north-first same-code neighbour mask to variants', () => {
    const grid = { columns: 3, rows: ['aaa', 'aba', 'aaa'] }
    expect(groundNeighbourMask(grid, 1, 1)).toBe(0)
    expect(groundNeighbourMask(grid, 0, 0)).toBe(4 | 16)
    expect(groundNeighbourMask({ columns: 3, rows: ['aaa', 'aaa', 'aaa'] }, 1, 1)).toBe(255)

    let received = -1
    selectGroundTexture(
      tileset,
      'b',
      1,
      1,
      (_code, _column, _row, mask) => {
        received = mask
        return 0
      },
      groundNeighbourMask(grid, 1, 1),
    )
    expect(received).toBe(0)
  })

  it('rejects unknown codes and invalid variant indexes', () => {
    expect(() => selectGroundTexture(tileset, 'z', 0, 0)).toThrow('Unknown ground code')
    expect(() => selectGroundTexture(tileset, 'b', 0, 0, () => 2)).toThrow(
      'outside its texture range',
    )
  })
})

describe('tiled ground lifecycle', () => {
  it('repaints one cell, enforces bounds, and releases its view once', () => {
    const ground = createTiledGround(
      { columns: 2, rows: ['ab'] },
      { tileSize: 1, textures: { a: Texture.EMPTY, b: Texture.WHITE } },
      { cellSize: 16 },
    )

    expect(ground.span).toEqual({ width: 32, height: 16 })
    expect(() => ground.setTile(0, 0, 'b')).not.toThrow()
    expect(() => ground.setTile(2, 0, 'a')).toThrow('outside the ground')
    expect(() => ground.setTile(0, 1, 'a')).toThrow('outside the ground')
    expect(() => ground.setTile(0, 0, 'z')).toThrow('Unknown ground code')
    expect(() => ground.setTile(0, 0, EMPTY_TILE_CODE)).toThrow('Unknown ground code')

    ground.destroy()
    ground.destroy()
    expect(ground.view.destroyed).toBe(true)
    expect(() => ground.setTile(0, 0, 'a')).toThrow('destroyed tiled ground')
  })

  it('packs ordered optional layers and repaints only the base with its updated mask', () => {
    const variants: [string, number, number, number][] = []
    const ground = createTiledGround(
      { columns: 3, rows: ['aba'] },
      { tileSize: 1, textures: { a: Texture.EMPTY, b: Texture.WHITE } },
      {
        cellSize: 16,
        layers: [{ columns: 3, rows: [`${EMPTY_TILE_CODE}b${EMPTY_TILE_CODE}`] }],
        variant: (code, column, row, mask) => {
          variants.push([code, column, row, mask])
          return 0
        },
      },
    )

    expect(ground.view.children).toHaveLength(1)
    const beforeRepaint = variants.length
    ground.setTile(1, 0, 'a')
    expect(variants.slice(beforeRepaint)).toEqual([['a', 1, 0, 4 | 64]])
  })
})

describe('sparse tiled ground', () => {
  it('accepts empty cells, packs them as null tiles, and retains the whole grid span', () => {
    const ground = createSparseTiledGround(
      { columns: 3, rows: [`${EMPTY_TILE_CODE}a${EMPTY_TILE_CODE}`, `aa${EMPTY_TILE_CODE}`] },
      { tileSize: 1, textures: { a: Texture.EMPTY } },
      { cellSize: 16 },
    )
    const map = ground.view.children[0] as unknown as {
      getTile(layer: string, column: number, row: number): unknown
    }

    expect(ground.view.children).toHaveLength(1)
    expect(ground.span).toEqual({ width: 48, height: 32 })
    expect(map.getTile('ground', 0, 0)).toBeNull()
    expect(map.getTile('ground', 1, 0)).not.toBeNull()
    expect(map.getTile('ground', 2, 1)).toBeNull()
  })

  it('validates sparse grid shape, codes, and cell size before creating its view', () => {
    const sparseTileset = { tileSize: 1, textures: { a: Texture.EMPTY } }

    expect(() =>
      createSparseTiledGround({ columns: 2, rows: ['a'] }, sparseTileset, { cellSize: 16 }),
    ).toThrow('expected 2')
    expect(() =>
      createSparseTiledGround({ columns: 1, rows: ['z'] }, sparseTileset, { cellSize: 16 }),
    ).toThrow('z')
    expect(() =>
      createSparseTiledGround({ columns: 1, rows: ['a'] }, sparseTileset, { cellSize: 0 }),
    ).toThrow('positive number')
  })

  it('uses original sparse coordinates and same-code masks for deterministic variants', () => {
    const variants: [string, number, number, number][] = []
    createSparseTiledGround(
      { columns: 3, rows: [`${EMPTY_TILE_CODE}a${EMPTY_TILE_CODE}`, 'aaa'] },
      { tileSize: 1, textures: { a: Texture.EMPTY } },
      {
        cellSize: 16,
        variant: (code, column, row, mask) => {
          variants.push([code, column, row, mask])
          return 0
        },
      },
    )

    expect(variants).toEqual([
      ['a', 1, 0, 8 | 16 | 32],
      ['a', 0, 1, 2 | 4],
      ['a', 1, 1, 1 | 4 | 64],
      ['a', 2, 1, 64 | 128],
    ])
  })

  it('keeps an all-empty grid as one empty, full-span map and releases it once', () => {
    const variant = vi.fn(() => 0)
    const ground = createSparseTiledGround(
      { columns: 2, rows: [`${EMPTY_TILE_CODE}${EMPTY_TILE_CODE}`] },
      { tileSize: 1, textures: { a: Texture.EMPTY } },
      { cellSize: 16, variant },
    )
    const map = ground.view.children[0] as unknown as {
      destroyed: boolean
      destroy(): void
      getTile(layer: string, column: number, row: number): unknown
    }
    const destroyMap = vi.spyOn(map, 'destroy')

    expect(ground.span).toEqual({ width: 32, height: 16 })
    expect(map.getTile('ground', 0, 0)).toBeNull()
    expect(map.getTile('ground', 1, 0)).toBeNull()
    expect(variant).not.toHaveBeenCalled()
    ground.destroy()
    ground.destroy()
    expect(destroyMap).toHaveBeenCalledTimes(1)
    expect(map.destroyed).toBe(true)
    expect(ground.view.destroyed).toBe(true)
  })
})
