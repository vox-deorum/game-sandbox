import { describe, expect, it } from 'vitest'

import {
  boundaryMask,
  edgeMarkFamilies,
  planEdges,
  terrainVariant,
  type EdgePairing,
} from './edges.js'
import { plankRowsFor } from './terrain-art.js'

const names = { w: 'water', g: 'ground', e: 'reeds', f: 'field', b: 'bridge' }
const waterBank: EdgePairing = {
  from: 'water',
  to: 'ground',
  frames: Array.from({ length: 16 }, (_, index) => `edge${index}`),
  tint: 'silt',
  corners: {
    northEast: ['cornerA', 'cornerB'],
    southEast: ['cornerC', 'cornerD'],
    southWest: ['cornerE', 'cornerF'],
    northWest: ['cornerG', 'cornerH'],
  },
  accents: ['bankShoulder', 'bankStones'],
}
const reeds: EdgePairing = { from: 'reeds', to: 'ground', frames: ['a', 'b', 'c'], tint: 'reed' }
const families = edgeMarkFamilies([waterBank, reeds])

function family(kind: 'cardinal' | 'corner' | 'accent', direction?: string) {
  const result = families.find((item) => item.kind === kind && item.direction === direction)
  if (result === undefined) throw new Error(`Missing ${kind} ${direction ?? ''} edge family.`)
  return result
}

describe('Three Branches terrain art planning', () => {
  it('selects fill variants from stable ground code and coordinates', () => {
    expect(terrainVariant(4, 'g', 12, 7)).toBe(terrainVariant(4, 'g', 12, 7))
    expect(terrainVariant(4, 'g', 12, 7)).toBeLessThan(4)
    expect(terrainVariant(1, 'g', 99, 4)).toBe(0)
  })

  it('uses a north-east-south-west cardinal mask and leaves map borders unmarked', () => {
    const rows = ['ggg', 'gwg', 'ggg']
    expect(boundaryMask(rows, names, 1, 1, 'ground')).toBe(1 | 2 | 4 | 8)
    expect(boundaryMask(['wg'], names, 0, 0, 'ground')).toBe(2)
    expect(boundaryMask(['w'], names, 0, 0, 'ground')).toBe(0)
  })

  it('pins 16-frame water masks while accents use a deterministic configured variant', () => {
    const plan = planEdges(['ggg', 'gwg', 'ggg'], names, families, 3)
    const cardinal = family('cardinal')
    const accent = family('accent')
    expect(plan.frameIndexAt(cardinal.code, 1, 1)).toBe(1 | 2 | 4 | 8)
    expect(plan.frameIndexAt(accent.code, 1, 1)).toBeLessThan(2)
    expect(planEdges(['ggg', 'gwg', 'ggg'], names, families, 3).frameIndexAt(accent.code, 1, 1)).toBe(
      plan.frameIndexAt(accent.code, 1, 1),
    )
  })

  it('detects configured diagonal corners at interiors and map borders without implicit outside ground', () => {
    const northEast = family('corner', 'northEast')
    const southEast = family('corner', 'southEast')
    const interior = planEdges(['wwg', 'www', 'www'], names, families, 3)
    expect(interior.layers[0]?.[1]?.[1]).toBe(northEast.code)
    expect(interior.frameIndexAt(northEast.code, 1, 1)).toBeLessThan(2)

    const border = planEdges(['www', 'wwg'], names, families, 3)
    expect(border.layers[0]?.[0]?.[1]).toBe(southEast.code)
    expect(planEdges(['www', 'wwg'], names, families, 3).frameIndexAt(southEast.code, 1, 0)).toBe(
      border.frameIndexAt(southEast.code, 1, 0),
    )
  })

  it('allocates cardinal, corner, and accent marks in order before deterministically dropping overflow', () => {
    const cardinal = family('cardinal')
    const southEast = family('corner', 'southEast')
    const accent = family('accent')
    const rows = ['wgw', 'www', 'wwg']
    const full = planEdges(rows, names, families, 3)
    expect(full.layers.map((layer) => layer[1]?.[1])).toEqual([
      cardinal.code,
      southEast.code,
      accent.code,
    ])
    const overflow = planEdges(rows, names, families, 2)
    expect(overflow.layers.map((layer) => layer[1]?.[1])).toEqual([cardinal.code, southEast.code])
    expect(overflow.dropped).toBeGreaterThan(0)
    expect(planEdges(rows, names, families, 2).layers).toEqual(overflow.layers)
  })

  it('places bridge planks on exactly bridge cells', () => {
    expect(plankRowsFor(['bgb', 'www'], names)).toEqual(['P P', '   '])
  })
})
