import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'

import { ATLAS_PAGES } from '../assets.js'
import { opaqueFillPixels, tintedMaskPixels } from '../ui/tint.js'
import { extractBridgeBoardSources } from './bridge-board-sources.js'

const SIZE = 128
const FILL_FAMILIES = [
  ['washA', 'washB', 'washC', 'washD'],
  ['roadA', 'roadB', 'roadC', 'roadD'],
  ['pathA', 'pathB', 'pathC', 'pathD'],
  ['furrowA', 'furrowB', 'furrowC', 'furrowD'],
  ['reedsA', 'reedsB', 'reedsC', 'reedsD'],
  ['rippleA', 'rippleB', 'rippleC', 'rippleD'],
  ['floorA', 'floorB', 'floorC', 'floorD'],
] as const
function frameFrom(
  group: string,
  name: string,
): { pixels: Uint8ClampedArray; width: number; height: number } {
  const page = ATLAS_PAGES.find((item) => item.group === group)
  if (page === undefined) throw new Error(`${group} atlas page is missing.`)
  const index = page.cells.findIndex((cell) => cell.name === name)
  if (index < 0) throw new Error(`${group} frame is missing: ${name}`)
  const path = resolve(
    process.cwd(),
    `../environments/three_branches/renderer/${page.pagePath.slice(2)}`,
  )
  const image = PNG.sync.read(readFileSync(path))
  const width = page.width / page.columns
  const height = page.height / page.rows
  const pixels = new Uint8ClampedArray(width * height * 4)
  const left = (index % page.columns) * width
  const top = Math.floor(index / page.columns) * height
  for (let row = 0; row < height; row += 1) {
    pixels.set(
      image.data.subarray(
        ((top + row) * image.width + left) * 4,
        ((top + row) * image.width + left + width) * 4,
      ),
      row * width * 4,
    )
  }
  return { pixels, width, height }
}

function frame(name: string): Uint8ClampedArray {
  const result = frameFrom('terrain', name)
  expect({ width: result.width, height: result.height }).toEqual({ width: SIZE, height: SIZE })
  return result.pixels
}

function channel(pixels: Uint8ClampedArray, x: number, y: number, offset: number): number {
  return pixels[(y * SIZE + x) * 4 + offset] ?? 0
}

function alphaCoverage(pixels: Uint8ClampedArray): number {
  let visible = 0
  for (let index = 3; index < pixels.length; index += 4) {
    if ((pixels[index] ?? 0) > 0) visible += 1
  }
  return visible / (SIZE * SIZE)
}

function edge(pixels: Uint8ClampedArray, side: 'top' | 'right' | 'bottom' | 'left'): number[] {
  return Array.from({ length: SIZE }, (_, offset) => {
    const x = side === 'left' ? 0 : side === 'right' ? SIZE - 1 : offset
    const y = side === 'top' ? 0 : side === 'bottom' ? SIZE - 1 : offset
    return channel(pixels, x, y, 0)
  })
}

function sourceOver(base: Uint8ClampedArray, overlay: Uint8ClampedArray): Uint8ClampedArray {
  const result = new Uint8ClampedArray(base)
  for (let index = 0; index < result.length; index += 4) {
    const amount = (overlay[index + 3] ?? 0) / 255
    for (let offset = 0; offset < 3; offset += 1) {
      result[index + offset] = Math.round(
        (overlay[index + offset] ?? 0) * amount + (result[index + offset] ?? 0) * (1 - amount),
      )
    }
    result[index + 3] = 255
  }
  return result
}

describe('Three Branches terrain raster contract', () => {
  it('uses opaque full-cell fills whose variants join at identical borders', () => {
    for (const family of FILL_FAMILIES) {
      const variants = family.map(frame)
      for (const pixels of variants) {
        for (let index = 3; index < pixels.length; index += 4) expect(pixels[index]).toBe(255)
        expect(edge(pixels, 'right')).toEqual(edge(pixels, 'left'))
        expect(edge(pixels, 'bottom')).toEqual(edge(pixels, 'top'))
      }
      for (const first of variants) {
        for (const second of variants) {
          expect(edge(first, 'right')).toEqual(edge(second, 'left'))
          expect(edge(first, 'bottom')).toEqual(edge(second, 'top'))
        }
      }
    }
  })

  it('preserves shallow upper walls in the terrain atlas', () => {
    for (const name of ['wallA', 'wallB', 'wallC', 'wallD']) {
      const pixels = frame(name)
      expect(alphaCoverage(pixels)).toBeLessThan(0.25)
      for (let y = 28; y < SIZE; y += 1) {
        for (let x = 0; x < SIZE; x += 1) expect(channel(pixels, x, y, 3)).toBe(0)
      }
    }
  })

  it('supplies three independent full-colour board sources from the bridge atlas', () => {
    const sourceFrame = frameFrom('bridges', 'boards')
    const sources = extractBridgeBoardSources(
      sourceFrame.pixels,
      sourceFrame.width,
      sourceFrame.height,
      'boards',
    )
    expect(sources).toHaveLength(3)
    for (const source of sources) {
      let visible = 0
      let coloured = false
      for (let index = 0; index < source.pixels.length; index += 4) {
        const alpha = source.pixels[index + 3] ?? 0
        if (alpha === 0) {
          expect(Array.from(source.pixels.slice(index, index + 3))).toEqual([0, 0, 0])
          continue
        }
        visible += 1
        if (
          source.pixels[index] !== source.pixels[index + 1] ||
          source.pixels[index + 1] !== source.pixels[index + 2]
        )
          coloured = true
      }
      expect(visible).toBeGreaterThan(0)
      expect(coloured).toBe(true)
    }
  })
})

describe('Three Branches terrain pixel composition', () => {
  it('keeps neighboring tinted fill variants seamless and restrained', () => {
    const first = frame('washA')
    const second = frame('washD')
    opaqueFillPixels(first, '#a9b98d')
    opaqueFillPixels(second, '#a9b98d')
    expect(edge(first, 'right')).toEqual(edge(second, 'left'))
    expect(Math.min(...first.filter((_, index) => index % 4 === 0))).toBeGreaterThanOrEqual(157)
    expect(Math.max(...first.filter((_, index) => index % 4 === 0))).toBeLessThanOrEqual(180)
  })

  it('repaints only a shallow upper-wall band', () => {
    const floor = frame('floorA')
    const wall = frame('wallC')
    opaqueFillPixels(floor, '#cbc08e')
    tintedMaskPixels(wall, '#273248')
    const result = sourceOver(floor, wall)
    expect(result.some((value, index) => index % 4 !== 3 && value !== floor[index])).toBe(true)
    for (let y = 28; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        const index = (y * SIZE + x) * 4
        expect(Array.from(result.slice(index, index + 4))).toEqual(
          Array.from(floor.slice(index, index + 4)),
        )
      }
    }
  })
})
