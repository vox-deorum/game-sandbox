import { Texture } from 'pixi.js'
import { describe, expect, it, vi } from 'vitest'

import {
  frameRectangle,
  opaqueFillCacheKey,
  opaqueFillPixels,
  tintedMaskCacheKey,
  tintedMaskFrame,
  tintedMaskPixels,
} from './tint.js'

const grid = {
  width: 64,
  height: 32,
  columns: 3,
  rows: 2,
  names: ['a', 'b', 'c', 'd', 'e', 'f'],
} as const

describe('Three Branches atlas tinting', () => {
  it('maps manifest frame order to atlas rectangles', () => {
    expect(frameRectangle(grid, 'a')).toMatchObject({ x: 0, y: 0, width: 64, height: 32 })
    expect(frameRectangle(grid, 'e')).toMatchObject({ x: 64, y: 32, width: 64, height: 32 })
    expect(() => frameRectangle(grid, 'missing')).toThrow('Unknown atlas frame')
  })

  it('keeps resolved family opacity variants in separate cache entries', () => {
    expect(tintedMaskCacheKey('washA', '#A9AE8A')).toBe('washA:#a9ae8a')
    expect(tintedMaskCacheKey('washA', '#A9AE8A', 0.75)).toBe('washA:#a9ae8a:0.75')
    expect(tintedMaskCacheKey('bridgeA', '#A17D58', 1, true)).toBe('bridgeA:#a17d58:mipmaps')
  })

  it('creates a separate mipmapped source when a baked mask requests it', () => {
    const context = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(64 * 32 * 4) })),
      putImageData: vi.fn(),
    } as unknown as CanvasRenderingContext2D
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(context as never)

    const ordinary = tintedMaskFrame(Texture.WHITE, grid, 'a', '#a9ae8a')
    const mipmapped = tintedMaskFrame(Texture.WHITE, grid, 'a', '#a9ae8a', 1, true)

    expect(ordinary).not.toBe(mipmapped)
    expect(ordinary.source.autoGenerateMipmaps).toBe(false)
    expect(mipmapped.source.autoGenerateMipmaps).toBe(true)
    getContext.mockRestore()
  })

  it('applies one resolved opacity without multiplying it by a global detail alpha', () => {
    const full = new Uint8ClampedArray([255, 255, 255, 200])
    const resolved = new Uint8ClampedArray(full)
    tintedMaskPixels(full, '#6480a0')
    tintedMaskPixels(resolved, '#6480a0', 0.75)
    expect([...full]).toEqual([100, 128, 160, 200])
    expect([...resolved]).toEqual([100, 128, 160, 150])
  })

  it('bakes opaque fill corners from the configured tint with restrained mask variation', () => {
    const pixels = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255])
    opaqueFillPixels(pixels, '#6480a0')
    expect([...pixels]).toEqual([100, 128, 160, 255, 93, 119, 149, 255, 107, 137, 171, 255])
  })

  it('keeps opaque fills separate from transparent mask cache entries', () => {
    expect(opaqueFillCacheKey('washA', '#A9AE8A')).toBe('fill:washA:#a9ae8a')
  })
})
