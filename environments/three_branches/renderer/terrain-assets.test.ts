import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'

import { TERRAIN_ATLAS_FRAME_NAMES } from './assets.js'
import { boundaryMask } from './edges.js'
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
const CORNER_QUADRANTS = {
  cornerA: 'northEast',
  cornerB: 'northEast',
  cornerC: 'southEast',
  cornerD: 'southEast',
  cornerE: 'southWest',
  cornerF: 'southWest',
  cornerG: 'northWest',
  cornerH: 'northWest',
} as const
const ACCENTS = [
  'bankShoulder',
  'bankStones',
  'reedShoulderA',
  'reedShoulderB',
  'reedShoulderC',
  'furrowEndA',
  'furrowEndB',
  'furrowEndC',
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

function sideAlpha(pixels: Uint8ClampedArray, side: 'north' | 'east' | 'south' | 'west'): number {
  let alpha = 0
  for (let primary = 32; primary < 96; primary += 1) {
    for (let depth = 0; depth < 24; depth += 1) {
      const x = side === 'west' ? depth : side === 'east' ? SIZE - 1 - depth : primary
      const y = side === 'north' ? depth : side === 'south' ? SIZE - 1 - depth : primary
      alpha += channel(pixels, x, y, 3)
    }
  }
  return alpha
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

  it('keeps cardinal masks narrow and confined to their declared sides', () => {
    const sides = [
      ['north', 1],
      ['east', 2],
      ['south', 4],
      ['west', 8],
    ] as const
    for (let mask = 0; mask < 16; mask += 1) {
      const pixels = frame(`edge${String(mask).padStart(2, '0')}`)
      expect(alphaCoverage(pixels)).toBeLessThanOrEqual(0.55)
      for (const [side, bit] of sides) {
        if ((mask & bit) === 0) expect(sideAlpha(pixels, side)).toBe(0)
        else expect(sideAlpha(pixels, side)).toBeGreaterThan(0)
      }
    }
  })

  it('confines every corner mark to its configured quadrant', () => {
    for (const [name, quadrant] of Object.entries(CORNER_QUADRANTS)) {
      const pixels = frame(name)
      for (let y = 0; y < SIZE; y += 1) {
        for (let x = 0; x < SIZE; x += 1) {
          if (channel(pixels, x, y, 3) === 0) continue
          expect(quadrant.endsWith('East') ? x >= SIZE / 2 : x < SIZE / 2).toBe(true)
          expect(quadrant.startsWith('north') ? y < SIZE / 2 : y >= SIZE / 2).toBe(true)
        }
      }
    }
  })

  it('preserves transparency in accents, bridge planks, and shallow upper walls', () => {
    for (const name of ACCENTS) {
      const coverage = alphaCoverage(frame(name))
      expect(coverage).toBeGreaterThan(0)
      expect(coverage).toBeLessThan(0.15)
    }
    for (const name of ['bridgeA', 'bridgeB', 'bridgeC']) {
      const coverage = alphaCoverage(frame(name))
      expect(coverage).toBeGreaterThan(0.6)
      expect(coverage).toBeLessThan(0.8)
    }
    for (const name of ['wallA', 'wallB', 'wallC', 'wallD']) {
      const pixels = frame(name)
      expect(alphaCoverage(pixels)).toBeLessThan(0.25)
      for (let y = 28; y < SIZE; y += 1) {
        for (let x = 0; x < SIZE; x += 1) expect(channel(pixels, x, y, 3)).toBe(0)
      }
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
    expect(Math.min(...first.filter((_, index) => index % 4 === 0))).toBeGreaterThanOrEqual(160)
    expect(Math.max(...first.filter((_, index) => index % 4 === 0))).toBeLessThanOrEqual(178)
  })

  it('composes one continuous bank across a mixed ground and reed shore', () => {
    const rows = ['rwg']
    const names = { r: 'reeds', w: 'water', g: 'ground' }
    const mask = boundaryMask(rows, names, 1, 0, ['ground', 'reeds'])
    expect(mask).toBe(10)
    const bank = frame(`edge${String(mask).padStart(2, '0')}`)
    tintedMaskPixels(bank, '#a57c52')
    expect(sideAlpha(bank, 'west')).toBeGreaterThan(0)
    expect(sideAlpha(bank, 'east')).toBeGreaterThan(0)
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
        expect(Array.from(result.slice(index, index + 4))).toEqual(Array.from(floor.slice(index, index + 4)))
      }
    }
  })
})
