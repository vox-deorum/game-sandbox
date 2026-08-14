import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'

import { TERRAIN_ATLAS_FRAME_NAMES } from './assets.js'
import { opaqueFillPixels, tintedMaskPixels } from './tint.js'

const SIZE = 128
const FILL_FAMILIES = [
  ['washA', 'washB', 'washC', 'washD'],
  ['roadA', 'roadB', 'roadC', 'roadD'],
  ['furrowA', 'furrowB', 'furrowC', 'furrowD'],
  ['reedsA', 'reedsB', 'reedsC', 'reedsD'],
  ['rippleA', 'rippleB', 'rippleC', 'rippleD'],
  ['floorA', 'floorB', 'floorC', 'floorD'],
] as const
function frame(name: string): Uint8ClampedArray {
  const path = resolve(
    process.cwd(),
    `../environments/three_branches/renderer/assets/terrain/${name}.png`,
  )
  const image = PNG.sync.read(readFileSync(path))
  expect({ width: image.width, height: image.height }).toEqual({ width: SIZE, height: SIZE })
  return new Uint8ClampedArray(image.data)
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

function alphaMassCoverage(pixels: Uint8ClampedArray): number {
  let alpha = 0
  for (let index = 3; index < pixels.length; index += 4) alpha += pixels[index] ?? 0
  return alpha / (SIZE * SIZE * 255)
}

function transparentSeamRuns(pixels: Uint8ClampedArray, direction: 'columns' | 'rows'): number[] {
  const seams = Array.from({ length: SIZE }, (_, primary) => {
    let alpha = 0
    for (let secondary = 0; secondary < SIZE; secondary += 1) {
      const x = direction === 'columns' ? primary : secondary
      const y = direction === 'columns' ? secondary : primary
      alpha += channel(pixels, x, y, 3)
    }
    return alpha / SIZE < 160
  })
  const runs: number[] = []
  for (let index = 0; index < seams.length; ) {
    if (!seams[index]) {
      index += 1
      continue
    }
    let end = index + 1
    while (seams[end]) end += 1
    runs.push(end - index)
    index = end
  }
  return runs
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
  it('keeps every named frame at 128 by 128 in grayscale-alpha', () => {
    for (const name of TERRAIN_ATLAS_FRAME_NAMES) {
      const pixels = frame(name)
      for (let index = 0; index < pixels.length; index += 4) {
        expect(pixels[index]).toBe(pixels[index + 1])
        expect(pixels[index]).toBe(pixels[index + 2])
      }
    }
  })

  it('uses opaque full-cell fills whose variants join at identical borders', () => {
    for (const family of FILL_FAMILIES) {
      const variants = family.map(frame)
      for (const pixels of variants) {
        for (let index = 3; index < pixels.length; index += 4) expect(pixels[index]).toBe(255)
      }
      for (const first of variants) {
        for (const second of variants) {
          expect(edge(first, 'right')).toEqual(edge(second, 'left'))
          expect(edge(first, 'bottom')).toEqual(edge(second, 'top'))
        }
      }
    }
  })

  it('preserves transparency in bridge planks and shallow upper walls', () => {
    for (const name of ['bridgeA', 'bridgeB', 'bridgeC']) {
      const coverage = alphaMassCoverage(frame(name))
      expect(coverage).toBeGreaterThanOrEqual(0.88)
      expect(coverage).toBeLessThanOrEqual(0.96)
    }
    for (const name of ['wallA', 'wallB', 'wallC', 'wallD']) {
      const pixels = frame(name)
      expect(alphaCoverage(pixels)).toBeLessThan(0.25)
      for (let y = 28; y < SIZE; y += 1) {
        for (let x = 0; x < SIZE; x += 1) expect(channel(pixels, x, y, 3)).toBe(0)
      }
    }
  })

  it('uses narrow perpendicular water seams for semantic horizontal and vertical decks', () => {
    const horizontal = frame('bridgeA')
    const vertical = frame('bridgeB')
    const horizontalSeams = transparentSeamRuns(horizontal, 'columns')
    const horizontalCrossSeams = transparentSeamRuns(horizontal, 'rows')
    const verticalSeams = transparentSeamRuns(vertical, 'rows')
    const verticalCrossSeams = transparentSeamRuns(vertical, 'columns')
    expect(horizontalSeams.length).toBeGreaterThanOrEqual(3)
    expect(verticalSeams.length).toBeGreaterThanOrEqual(3)
    expect(Math.max(...horizontalSeams)).toBeLessThanOrEqual(5)
    expect(Math.max(...verticalSeams)).toBeLessThanOrEqual(5)
    expect(horizontalSeams.length).toBeGreaterThan(horizontalCrossSeams.length)
    expect(verticalSeams.length).toBeGreaterThan(verticalCrossSeams.length)
  })
})

describe('Three Branches terrain pixel composition', () => {
  it('keeps neighboring tinted fill variants seamless and restrained', () => {
    const first = frame('washA')
    const second = frame('washD')
    opaqueFillPixels(first, '#a9b98d')
    opaqueFillPixels(second, '#a9b98d')
    expect(edge(first, 'right')).toEqual(edge(second, 'left'))
    expect(Math.min(...first.filter((_, index) => index % 4 === 0))).toBeGreaterThanOrEqual(160)
    expect(Math.max(...first.filter((_, index) => index % 4 === 0))).toBeLessThanOrEqual(178)
  })

  it('leaves water visible between bridge planks', () => {
    const water = frame('rippleB')
    const planks = frame('bridgeA')
    opaqueFillPixels(water, '#6480a0')
    tintedMaskPixels(planks, '#6d4a36')
    const result = sourceOver(water, planks)
    let unchanged = 0
    let changed = 0
    for (let index = 0; index < result.length; index += 4) {
      if (result[index] === water[index] && result[index + 1] === water[index + 1]) unchanged += 1
      else changed += 1
    }
    expect(unchanged).toBeGreaterThan(0)
    expect(changed).toBeGreaterThan(0)
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
