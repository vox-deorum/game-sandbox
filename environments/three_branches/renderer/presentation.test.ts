import { describe, expect, it } from 'vitest'

import {
  CARDINAL_EDGE_FRAMES,
  type FrameTreatment,
  HEARTHSIDE_PALETTE_KEYS,
  HEARTHSIDE_STYLE,
  measureDeliveryGap,
  type PhaseGrade,
  phaseGrade,
  readHearthsideStyle,
  transitionDurationMs,
} from './presentation.js'

const APPROVED_PALETTE = {
  backdrop: '#101816',
  parchment: '#cfc5a9',
  bone: '#efe7d3',
  ink: '#6f6757',
  reed: '#a9ae8a',
  silt: '#bfa072',
  water: '#5a7680',
  pine: '#4f6a4b',
  indigo: '#27436b',
  cinnabar: '#b0402e',
  gilt: '#d9a441',
  violet: '#6b5d72',
  timber: '#8a6246',
} as const

const EDGE_TARGETS = {
  water: ['ground', 'reeds', 'field', 'road', 'path'],
  road: ['ground', 'reeds', 'field'],
  path: ['ground', 'reeds', 'field'],
  field: ['ground', 'reeds'],
} as const

describe('Hearthside Ink presentation', () => {
  it('exports exactly the thirteen approved palette colors', () => {
    expect(HEARTHSIDE_PALETTE_KEYS).toHaveLength(13)
    expect(HEARTHSIDE_STYLE.palette).toEqual(APPROVED_PALETTE)
  })

  it('keeps day neutral and configures every graded rules phase', () => {
    expect(Object.keys(HEARTHSIDE_STYLE.phaseGrades)).toEqual([
      'dawn',
      'morning',
      'midday',
      'evening',
      'night',
    ])
    expect(phaseGrade('day')).toBeNull()
    expect(phaseGrade('midday')).toBe(HEARTHSIDE_STYLE.phaseGrades.midday)
  })

  it('uses explicit host pace and caps unpaced delivery gaps at the natural duration', () => {
    expect(transitionDurationMs({ snap: true }, 400)).toBe(0)
    expect(transitionDurationMs({ transitionScale: 0 }, 400)).toBe(0)
    expect(transitionDurationMs({ transitionScale: 0.5 }, 900)).toBe(500)
    expect(transitionDurationMs(undefined, 240)).toBe(240)
    expect(transitionDurationMs(undefined, 1_400)).toBe(1_000)
    expect(transitionDurationMs()).toBe(1_000)
    expect(transitionDurationMs(undefined, Number.NaN)).toBe(1_000)
  })

  it('measures consecutive unpaced deliveries and resets the clock on snaps and pacing', () => {
    expect(measureDeliveryGap(null, 100)).toEqual({ gapMs: undefined, nextMs: 100 })
    expect(measureDeliveryGap(100, 340)).toEqual({ gapMs: 240, nextMs: 340 })
    expect(measureDeliveryGap(340, 500, { snap: true })).toEqual({
      gapMs: undefined,
      nextMs: null,
    })
    expect(measureDeliveryGap(null, 700)).toEqual({ gapMs: undefined, nextMs: 700 })
    expect(measureDeliveryGap(700, 900, { transitionScale: 0.5 })).toEqual({
      gapMs: undefined,
      nextMs: null,
    })
  })

  it('cuts roads into ground and overlays soft water, path, and field joins', () => {
    const pairings = HEARTHSIDE_STYLE.terrain.edges.pairings
    expect(pairings.map((pairing) => pairing.from)).toEqual(Object.keys(EDGE_TARGETS))
    expect(pairings.map((pairing) => pairing.to)).toEqual(Object.values(EDGE_TARGETS))
    expect(pairings.every((pairing) => new Set(pairing.to).size === pairing.to.length)).toBe(true)
    expect(pairings.map((pairing) => pairing.mode)).toEqual([
      'overlay',
      'cutout',
      'overlay',
      'overlay',
    ])
    expect(pairings.map((pairing) => pairing.frames)).toEqual([
      CARDINAL_EDGE_FRAMES,
      CARDINAL_EDGE_FRAMES,
      CARDINAL_EDGE_FRAMES,
      CARDINAL_EDGE_FRAMES,
    ])
    const overlays = pairings.filter((pairing) => pairing.mode === 'overlay')
    expect(overlays.map((pairing) => pairing.tint)).toEqual(['silt', 'reed', 'reed'])
    expect(overlays.map((pairing) => pairing.opacity)).toEqual([0.3, 0.22, 0.28])
    expect(pairings[1]).toEqual({
      mode: 'cutout',
      from: 'road',
      to: ['ground', 'reeds', 'field'],
      frames: CARDINAL_EDGE_FRAMES,
    })
    expect(overlays[0]?.corners).toEqual({
      frames: {
        northEast: ['cornerA', 'cornerB'],
        southEast: ['cornerC', 'cornerD'],
        southWest: ['cornerE', 'cornerF'],
        northWest: ['cornerG', 'cornerH'],
      },
      opacity: 0.22,
    })
    expect(overlays.map((pairing) => pairing.accents)).toEqual([
      { frames: ['bankShoulder', 'bankStones'], density: 0.18, opacity: 0.12 },
      undefined,
      undefined,
    ])
  })

  it('uses bridge-over-water fills, reed fills, indigo wall fills, and timber planks', () => {
    const terrain = HEARTHSIDE_STYLE.terrain
    expect(terrain.fills.bridge).toEqual({ frames: ['rippleA', 'rippleB', 'rippleC', 'rippleD'], tint: 'water' })
    expect(terrain.fills.reeds).toEqual({ frames: ['reedsA', 'reedsB', 'reedsC', 'reedsD'], tint: 'reed' })
    expect(terrain.fills.wall).toEqual({ frames: ['floorA', 'floorB', 'floorC', 'floorD'], tint: 'indigo' })
    expect(terrain.planks).toEqual({
      horizontal: 'bridgeA',
      vertical: 'bridgeB',
      compact: 'bridgeC',
      tint: 'timber',
    })
    expect(terrain.upperWall).toEqual({ frames: ['wallA', 'wallB', 'wallC', 'wallD'], tint: 'indigo' })
  })

  it('rejects invalid terrain target lists, duplicated sources, and invalid detail values', () => {
    const duplicateTarget = structuredClone(HEARTHSIDE_STYLE) as any
    duplicateTarget.terrain.edges.pairings[0].to = ['ground', 'ground']
    expect(() => readHearthsideStyle(duplicateTarget)).toThrow('must not contain duplicate targets')

    const emptyTarget = structuredClone(HEARTHSIDE_STYLE) as any
    emptyTarget.terrain.edges.pairings[0].to = []
    expect(() => readHearthsideStyle(emptyTarget)).toThrow('must contain at least one target')

    const unknownTarget = structuredClone(HEARTHSIDE_STYLE) as any
    unknownTarget.terrain.edges.pairings[0].to = ['missing']
    expect(() => readHearthsideStyle(unknownTarget)).toThrow('to[0] is unknown')

    const duplicateSource = structuredClone(HEARTHSIDE_STYLE) as any
    duplicateSource.terrain.edges.pairings.push(
      structuredClone(duplicateSource.terrain.edges.pairings[1]),
    )
    expect(() => readHearthsideStyle(duplicateSource)).toThrow('must configure each source once')

    const badOpacity = structuredClone(HEARTHSIDE_STYLE) as any
    badOpacity.terrain.edges.pairings[0].corners.opacity = 1.1
    expect(() => readHearthsideStyle(badOpacity)).toThrow('corners.opacity must be at most one')

    const badDensity = structuredClone(HEARTHSIDE_STYLE) as any
    badDensity.terrain.edges.pairings[0].accents.density = -0.01
    expect(() => readHearthsideStyle(badDensity)).toThrow('accents.density must be non-negative')

    const badFrame = structuredClone(HEARTHSIDE_STYLE) as any
    badFrame.terrain.edges.pairings[0].accents.frames = ['missingFrame']
    expect(() => readHearthsideStyle(badFrame)).toThrow('accents.frames[0] is unknown')

    const meaninglessCutoutTint = structuredClone(HEARTHSIDE_STYLE) as any
    meaninglessCutoutTint.terrain.edges.pairings[1].tint = 'ink'
    expect(() => readHearthsideStyle(meaninglessCutoutTint)).toThrow('keys do not match')

    const missingMode = structuredClone(HEARTHSIDE_STYLE) as any
    delete missingMode.terrain.edges.pairings[1].mode
    expect(() => readHearthsideStyle(missingMode)).toThrow('mode must be overlay or cutout')

    const reordered = structuredClone(HEARTHSIDE_STYLE) as any
    ;[reordered.terrain.edges.pairings[1].frames[0], reordered.terrain.edges.pairings[1].frames[1]] = [
      reordered.terrain.edges.pairings[1].frames[1],
      reordered.terrain.edges.pairings[1].frames[0],
    ]
    expect(() => readHearthsideStyle(reordered)).toThrow('cardinal order')
  })

  it('rejects unknown manifest frames, palette tints, and phase keys', () => {
    const badFrame = structuredClone(HEARTHSIDE_STYLE)
    const fills = badFrame.terrain.fills as Record<string, FrameTreatment>
    fills.ground = { frames: ['missingFrame'], tint: 'reed' }
    expect(() => readHearthsideStyle(badFrame)).toThrow('frames[0] is unknown')

    const badTint = structuredClone(HEARTHSIDE_STYLE)
    const tintFills = badTint.terrain.fills as Record<string, { frames: string[]; tint: string }>
    tintFills.ground = { frames: ['washA'], tint: 'orange' }
    expect(() => readHearthsideStyle(badTint)).toThrow('tint is unknown')

    const badPlank = structuredClone(HEARTHSIDE_STYLE) as any
    badPlank.terrain.planks.horizontal = 'missingFrame'
    expect(() => readHearthsideStyle(badPlank)).toThrow('planks.horizontal is unknown')

    const badPhases = structuredClone(HEARTHSIDE_STYLE)
    const grades = badPhases.phaseGrades as Record<string, PhaseGrade>
    grades.day = grades.midday as PhaseGrade
    expect(() => readHearthsideStyle(badPhases)).toThrow('phaseGrades keys')
  })
})
