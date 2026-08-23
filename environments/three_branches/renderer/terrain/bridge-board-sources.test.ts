import type { Texture } from 'pixi.js'
import { describe, expect, it, vi } from 'vitest'

import { bridgeBoardSourcesFor, extractBridgeBoardSources } from './bridge-board-sources.js'

function syntheticBoardFrame(
  width: number,
  coreRuns: readonly (readonly [number, number])[],
): Uint8ClampedArray {
  const height = 12
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (const [start, end] of coreRuns) {
    for (let column = Math.max(0, start - 1); column < Math.min(width, end + 1); column += 1) {
      const alpha = column >= start && column < end ? 255 : 48
      for (let row = 0; row < height; row += 1) {
        const offset = (row * width + column) * 4
        pixels[offset] = 128 + column
        pixels[offset + 1] = 96 + row
        pixels[offset + 2] = 64
        pixels[offset + 3] = alpha
      }
    }
  }
  // Sparse opaque noise must not become a fourth board core.
  pixels[22 * 4 + 3] = 255
  return pixels
}

describe('Three Branches bridge board sources', () => {
  it('reads the configured frame rectangle from a borrowed atlas resource', () => {
    const pixels = syntheticBoardFrame(24, [
      [2, 7],
      [9, 15],
      [17, 22],
    ])
    const resource = {} as CanvasImageSource
    const drawImage = vi.fn()
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage,
        getImageData: () => ({ data: pixels }) as ImageData,
      }),
    } as unknown as HTMLCanvasElement
    const createElement = vi.spyOn(document, 'createElement').mockReturnValue(canvas)
    try {
      const sources = bridgeBoardSourcesFor(
        { source: { resource } } as Texture,
        { width: 24, height: 12, columns: 2, rows: 1, names: ['other', 'boards'] },
        'boards',
      )

      expect(sources).toHaveLength(3)
      expect(drawImage).toHaveBeenCalledWith(resource, 24, 0, 24, 12, 0, 0, 24, 12)
      expect(canvas).toMatchObject({ width: 24, height: 12 })
    } finally {
      createElement.mockRestore()
    }
  })

  it('extracts three ordered full-colour sources by scanning frame columns', () => {
    const pixels = syntheticBoardFrame(24, [
      [2, 7],
      [9, 15],
      [17, 22],
    ])
    const sources = extractBridgeBoardSources(pixels, 24, 12, 'boards')

    expect(sources).toHaveLength(3)
    expect(sources.map((source) => [source.width, source.height])).toEqual([
      [7, 12],
      [8, 12],
      [7, 12],
    ])
    expect(sources[0]?.pixels[0]).toBe(129)
    expect(sources[0]?.pixels[1]).toBe(96)
    expect(sources[0]?.pixels[3]).toBe(48)
  })

  it.each([2, 4])('rejects a malformed source with %i board cores', (count) => {
    const runs = Array.from(
      { length: count },
      (_, index) => [index * 3 + 1, index * 3 + 2] as const,
    )
    expect(() => extractBridgeBoardSources(syntheticBoardFrame(16, runs), 16, 12, 'bad')).toThrow(
      `Three Branches bridge board source bad is malformed: must contain exactly three board cores, found ${count}.`,
    )
  })
})
