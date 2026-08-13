import { describe, expect, it } from 'vitest'

import { frameRectangle, tintedMaskCacheKey } from './tint.js'

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

  it('normalizes tint spelling in the per-atlas cache key', () => {
    expect(tintedMaskCacheKey('washA', '#A9AE8A')).toBe('washA:#a9ae8a')
  })
})
