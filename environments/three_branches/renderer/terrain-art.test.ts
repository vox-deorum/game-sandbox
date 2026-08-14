import { describe, expect, it } from 'vitest'

import {
  boundaryMask,
  cutoutVariant,
  edgeMarkFamilies,
  planEdges,
  terrainVariant,
  type EdgePairing,
} from './edges.js'
import { CARDINAL_EDGE_FRAMES, HEARTHSIDE_STYLE } from './presentation.js'
import { BRIDGE_PLANK_CODES, plankRowsFor } from './terrain-art.js'

const names: Readonly<Record<string, string>> = {
  w: 'water',
  g: 'ground',
  e: 'reeds',
  f: 'field',
  r: 'road',
  p: 'path',
  b: 'bridge',
}
const waterBank: EdgePairing = {
  mode: 'overlay',
  from: 'water',
  to: ['ground', 'reeds'],
  frames: CARDINAL_EDGE_FRAMES,
  tint: 'silt',
  opacity: 1,
  corners: {
    frames: {
      northEast: ['cornerA', 'cornerB'],
      southEast: ['cornerC', 'cornerD'],
      southWest: ['cornerE', 'cornerF'],
      northWest: ['cornerG', 'cornerH'],
    },
    opacity: 0.75,
  },
  accents: { frames: ['bankShoulder'], density: 1, opacity: 0.22 },
}
const reeds: EdgePairing = {
  mode: 'overlay',
  from: 'reeds',
  to: ['ground', 'field'],
  frames: CARDINAL_EDGE_FRAMES,
  tint: 'pine',
  opacity: 0.45,
  accents: { frames: ['reedShoulderA'], density: 1, opacity: 0.3 },
}
const field: EdgePairing = {
  mode: 'overlay',
  from: 'field',
  to: ['ground'],
  frames: CARDINAL_EDGE_FRAMES,
  tint: 'ink',
  opacity: 0.3,
  accents: { frames: ['furrowEndA'], density: 1, opacity: 0.28 },
}
const roadCutout: EdgePairing = {
  mode: 'cutout',
  from: 'road',
  to: ['ground', 'reeds', 'field'],
  frames: CARDINAL_EDGE_FRAMES,
}
const families = edgeMarkFamilies([waterBank, reeds, field])

function family(kind: 'cardinal' | 'corner' | 'accent', from = 'water', direction?: string) {
  const result = families.find(
    (item) => item.kind === kind && item.from === from && item.direction === direction,
  )
  if (result === undefined) throw new Error(`Missing ${kind} ${from} ${direction ?? ''} edge family.`)
  return result
}

describe('Three Branches terrain art planning', () => {
  it('selects fill variants from stable ground code and coordinates', () => {
    expect(terrainVariant(4, 'g', 12, 7)).toBe(terrainVariant(4, 'g', 12, 7))
    expect(terrainVariant(4, 'g', 12, 7)).toBeLessThan(4)
    expect(terrainVariant(1, 'g', 99, 4)).toBe(0)
  })

  it('does not repeat fill variants on a four-cell lattice', () => {
    const grid = Array.from({ length: 8 }, (_, row) =>
      Array.from({ length: 8 }, (_, column) => terrainVariant(4, 'g', column, row)),
    )
    expect(new Set(grid.flat())).toEqual(new Set([0, 1, 2, 3]))
    expect(grid.slice(0, 4)).not.toEqual(grid.slice(4))
    expect(grid.every((row) => row.slice(0, 4).join('') !== row.slice(4).join(''))).toBe(true)
  })

  it('uses a north-east-south-west mask for the union of configured target classes', () => {
    const rows = ['ggg', 'gwg', 'ggg']
    expect(boundaryMask(rows, names, 1, 1, ['ground'])).toBe(1 | 2 | 4 | 8)
    expect(boundaryMask(['ewg'], names, 1, 0, ['ground', 'reeds'])).toBe(2 | 8)
    expect(boundaryMask(['w'], names, 0, 0, ['ground', 'reeds'])).toBe(0)
  })

  it('uses one mixed water mask and one cardinal family per source cell', () => {
    const plan = planEdges(['ewg'], names, families, 3)
    const cardinal = family('cardinal')
    expect(plan.frameIndexAt(cardinal.code, 1, 0)).toBe(2 | 8)
    expect(plan.layers.filter((layer) => layer[0]?.[1] === cardinal.code)).toHaveLength(1)
  })

  it('excludes cutouts from packed overlay families', () => {
    expect(edgeMarkFamilies([waterBank, roadCutout]).every((item) => item.from !== 'road')).toBe(true)
  })

  it('selects road composites in mask-major order and leaves road-to-path uncut', () => {
    const rows = ['grpg', 'gggg']
    expect(boundaryMask(rows, names, 1, 0, roadCutout.to)).toBe(4 | 8)
    const expectedDetail = terrainVariant(4, 'r', 1, 0)
    expect(cutoutVariant(rows, names, roadCutout, 1, 0, 4)).toBe((4 | 8) * 4 + expectedDetail)
    expect(cutoutVariant(rows, names, roadCutout, 1, 0, 4)).toBe(
      cutoutVariant(rows, names, roadCutout, 1, 0, 4),
    )
  })

  it('expands every cardinal family before water corners and all accents', () => {
    expect(families.map((item) => `${item.kind}:${item.from}:${item.direction ?? ''}`)).toEqual([
      'cardinal:water:',
      'cardinal:reeds:',
      'cardinal:field:',
      'corner:water:northEast',
      'corner:water:southEast',
      'corner:water:southWest',
      'corner:water:northWest',
      'accent:water:',
      'accent:reeds:',
      'accent:field:',
    ])
  })

  it('detects configured diagonal corners from the composite target union', () => {
    const northEast = family('corner', 'water', 'northEast')
    const plan = planEdges(['wwg', 'www', 'www'], names, families, 3)
    expect(plan.layers[0]?.[1]?.[1]).toBe(northEast.code)
    expect(plan.frameIndexAt(northEast.code, 1, 1)).toBeLessThan(2)
  })

  it('includes sparse accents by stable hash and deterministically drops optional decoration', () => {
    const noAccent: EdgePairing = {
      ...waterBank,
      accents: { frames: ['bankShoulder'], density: 0, opacity: 0.22 },
    }
    const allAccent: EdgePairing = {
      ...waterBank,
      accents: { frames: ['bankShoulder'], density: 1, opacity: 0.22 },
    }
    const noAccentFamilies = edgeMarkFamilies([noAccent])
    const allAccentFamilies = edgeMarkFamilies([allAccent])
    const noAccentPlan = planEdges(['ggg', 'gwg', 'ggg'], names, noAccentFamilies, 2)
    const allAccentPlan = planEdges(['ggg', 'gwg', 'ggg'], names, allAccentFamilies, 2)
    expect(noAccentPlan.dropped).toBe(0)
    expect(allAccentPlan.layers).toEqual(planEdges(['ggg', 'gwg', 'ggg'], names, allAccentFamilies, 2).layers)
    expect(allAccentPlan.dropped).toBe(0)
    expect(allAccentPlan.layers.flat().join('')).toContain(allAccentFamilies[5]?.code)
  })

  it('keeps cardinals when three-layer overflow drops later corners and accents', () => {
    const cardinal = family('cardinal')
    const southEast = family('corner', 'water', 'southEast')
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

  it('orients a three-by-three bridge from paired east and west road contacts', () => {
    expect(plankRowsFor(['ggggg', 'gbbbg', 'rbbbr', 'gbbbg', 'ggggg'], names)).toEqual([
      '     ',
      ` ${BRIDGE_PLANK_CODES.horizontal.repeat(3)} `,
      ` ${BRIDGE_PLANK_CODES.horizontal.repeat(3)} `,
      ` ${BRIDGE_PLANK_CODES.horizontal.repeat(3)} `,
      '     ',
    ])
  })

  it('orients a three-by-three bridge from paired north and south path contacts', () => {
    expect(plankRowsFor(['ggpgg', 'gbbbg', 'gbbbg', 'gbbbg', 'ggpgg'], names)).toEqual([
      '     ',
      ` ${BRIDGE_PLANK_CODES.vertical.repeat(3)} `,
      ` ${BRIDGE_PLANK_CODES.vertical.repeat(3)} `,
      ` ${BRIDGE_PLANK_CODES.vertical.repeat(3)} `,
      '     ',
    ])
  })

  it('keeps an irregular four-by-three component horizontal with one extra north contact', () => {
    expect(plankRowsFor(['ggrggg', 'rbbbbr', 'gbbbbg', 'gbbbbg'], names)).toEqual([
      '      ',
      ` ${BRIDGE_PLANK_CODES.horizontal.repeat(4)} `,
      ` ${BRIDGE_PLANK_CODES.horizontal.repeat(4)} `,
      ` ${BRIDGE_PLANK_CODES.horizontal.repeat(4)} `,
    ])
  })

  it('plans separate components independently and uses compact as the deterministic tie fallback', () => {
    const rows = ['ggrgggg', 'ggbgggg', 'ggrgggg', 'rbrggbg', 'ggggggg']
    const expected = [
      '       ',
      `  ${BRIDGE_PLANK_CODES.vertical}    `,
      '       ',
      ` ${BRIDGE_PLANK_CODES.horizontal}   ${BRIDGE_PLANK_CODES.compact} `,
      '       ',
    ]
    expect(plankRowsFor(rows, names)).toEqual(expected)
    expect(plankRowsFor(rows, names)).toEqual(plankRowsFor(rows, names))
    for (let row = 0; row < rows.length; row += 1) {
      for (let column = 0; column < rows[row]!.length; column += 1) {
        expect(plankRowsFor(rows, names)[row]![column] !== ' ').toBe(
          names[rows[row]![column]!] === 'bridge',
        )
      }
    }
  })

  it('keeps the approved bridge material roles exact', () => {
    const edgeCodes = new Set(
      edgeMarkFamilies(HEARTHSIDE_STYLE.terrain.edges.pairings).map((family) => family.code),
    )
    expect(Object.values(BRIDGE_PLANK_CODES).every((code) => !edgeCodes.has(code))).toBe(true)
    expect(HEARTHSIDE_STYLE.terrain.fills.bridge).toEqual({
      frames: ['rippleA', 'rippleB', 'rippleC', 'rippleD'],
      tint: 'water',
    })
    expect(HEARTHSIDE_STYLE.terrain.planks).toEqual({
      horizontal: 'bridgeA',
      vertical: 'bridgeB',
      compact: 'bridgeC',
      tint: 'timber',
    })
  })
})
