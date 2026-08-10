import { Texture } from 'pixi.js'
import { describe, expect, it } from 'vitest'

import {
  createTiledGround,
  type GroundTileset,
  selectGroundTexture,
  tileGridSpan,
  validateGroundGrid,
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
  })

  it('rejects grid codes that have no tileset texture', () => {
    expect(() => validateGroundGrid({ columns: 2, rows: ['az'] }, tileset)).toThrow('"z"')
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

    ground.destroy()
    ground.destroy()
    expect(ground.view.destroyed).toBe(true)
    expect(() => ground.setTile(0, 0, 'a')).toThrow('destroyed tiled ground')
  })
})
