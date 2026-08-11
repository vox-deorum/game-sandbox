import { Sprite, Texture } from 'pixi.js'
import { describe, expect, it } from 'vitest'

import { clamp, degreesToRadians, lerp, stableHash } from '../src/renderers/base/math.js'
import { applyTexture, centeredSprite, flattenPoints } from '../src/renderers/base/pixi-helpers.js'

describe('renderer math', () => {
  it('clamps values to an inclusive range', () => {
    expect(clamp(-2, 0, 4)).toBe(0)
    expect(clamp(2, 0, 4)).toBe(2)
    expect(clamp(6, 0, 4)).toBe(4)
  })

  it('interpolates numbers and converts degrees', () => {
    expect(lerp(10, 20, 0.25)).toBe(12.5)
    expect(degreesToRadians(180)).toBe(Math.PI)
  })

  it('keeps presentation hashes stable', () => {
    expect(stableHash('renderer-key')).toBe(590_418_368)
    expect(stableHash('')).toBe(2_166_136_261)
    expect(stableHash('renderer-key')).not.toBe(stableHash('Renderer-Key'))
  })
})

describe('Pixi helpers', () => {
  it('flattens points in drawing order', () => {
    expect(
      flattenPoints([
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ]),
    ).toEqual([1, 2, 3, 4])
  })

  it('creates centered sprites and applies optional textures', () => {
    const sprite = centeredSprite()
    expect(sprite.anchor.x).toBe(0.5)
    expect(sprite.anchor.y).toBe(0.5)

    applyTexture(sprite, Texture.WHITE, 12, 18)
    expect(sprite.texture).toBe(Texture.WHITE)
    expect(sprite.width).toBe(12)
    expect(sprite.height).toBe(18)
    expect(sprite.visible).toBe(true)

    applyTexture(sprite, null, 6, 9)
    expect(sprite.texture).toBe(Texture.EMPTY)
    expect(sprite.visible).toBe(false)
    sprite.destroy()
  })

  it('also applies textures to ordinary sprites', () => {
    const sprite = new Sprite()
    applyTexture(sprite, Texture.WHITE, 2, 3)
    expect(sprite.width).toBe(2)
    expect(sprite.height).toBe(3)
    sprite.destroy()
  })
})
