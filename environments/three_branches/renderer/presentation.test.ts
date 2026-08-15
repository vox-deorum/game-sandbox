import { describe, expect, it } from 'vitest'

import {
  HEARTHSIDE_PALETTE_KEYS,
  HEARTHSIDE_STYLE,
  measureDeliveryGap,
  type PhaseGrade,
  phaseGrade,
  readHearthsideStyle,
  type TerrainFillTreatment,
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

const APPROVED_CONTOURS = {
  smoothingPasses: 2,
  cornerWeight: 0.25,
  sampleSpacingCells: 0.5,
  junctionTangentCells: 0.25,
  noiseAmplitudeCells: 0.06,
  noiseWavelengthCells: [1.5, 3],
  maxDeviationCells: 0.15,
  saddleRadiusCells: 0.08,
  shoreline: {
    bands: [
      { tint: 'reed', widthCells: 0.32, opacity: 0.16 },
      { tint: 'silt', widthCells: 0.16, opacity: 0.36 },
    ],
    bridgeTaperCells: 0.25,
  },
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

  it('pins the approved continuous contour and quiet shoreline calibration', () => {
    expect(HEARTHSIDE_STYLE.terrain.contours).toEqual(APPROVED_CONTOURS)
    expect(HEARTHSIDE_STYLE.terrain.fills.road?.tint).toBe('timber')
    expect(HEARTHSIDE_STYLE.terrain.fills.road?.tint).not.toBe(
      HEARTHSIDE_STYLE.terrain.fills.field?.tint,
    )
    expect(HEARTHSIDE_STYLE.terrain.fills.road?.tint).not.toBe(
      HEARTHSIDE_STYLE.terrain.fills.path?.tint,
    )
  })

  it('uses bridge-over-water fills, reed fills, indigo wall fills, and timber planks', () => {
    const terrain = HEARTHSIDE_STYLE.terrain
    expect(terrain.fills.bridge).toEqual({
      frames: ['rippleA', 'rippleB', 'rippleC', 'rippleD'],
      tint: 'water',
      opacity: 1,
    })
    expect(terrain.fills.reeds).toEqual({
      frames: ['reedsA', 'reedsB', 'reedsC', 'reedsD'],
      tint: 'reed',
      opacity: 1,
    })
    expect(terrain.fills.wall).toEqual({
      frames: ['floorA', 'floorB', 'floorC', 'floorD'],
      tint: 'indigo',
      opacity: 1,
    })
    expect(terrain.planks).toEqual({
      horizontal: 'bridgeA',
      vertical: 'bridgeB',
      compact: 'bridgeC',
      tint: 'timber',
    })
    expect(terrain.upperWall).toEqual({
      frames: ['wallA', 'wallB', 'wallC', 'wallD'],
      tint: 'indigo',
    })
  })

  it('rejects invalid contour geometry and shoreline calibration', () => {
    const extraKey = structuredClone(HEARTHSIDE_STYLE) as any
    extraKey.terrain.contours.mode = 'tiles'
    expect(() => readHearthsideStyle(extraKey)).toThrow('keys do not match')

    const badSpacing = structuredClone(HEARTHSIDE_STYLE) as any
    badSpacing.terrain.contours.sampleSpacingCells = 0.51
    expect(() => readHearthsideStyle(badSpacing)).toThrow('sampleSpacingCells')

    const badWavelength = structuredClone(HEARTHSIDE_STYLE) as any
    badWavelength.terrain.contours.noiseWavelengthCells = [1.49, 3]
    expect(() => readHearthsideStyle(badWavelength)).toThrow('noiseWavelengthCells[0]')

    const excessiveDeviation = structuredClone(HEARTHSIDE_STYLE) as any
    excessiveDeviation.terrain.contours.maxDeviationCells = 0.151
    expect(() => readHearthsideStyle(excessiveDeviation)).toThrow('maxDeviationCells')

    const excessiveNoise = structuredClone(HEARTHSIDE_STYLE) as any
    excessiveNoise.terrain.contours.noiseAmplitudeCells = 0.061
    expect(() => readHearthsideStyle(excessiveNoise)).toThrow('noiseAmplitudeCells')

    const excessiveSaddle = structuredClone(HEARTHSIDE_STYLE) as any
    excessiveSaddle.terrain.contours.saddleRadiusCells = 0.081
    expect(() => readHearthsideStyle(excessiveSaddle)).toThrow('saddleRadiusCells')

    const badBands = structuredClone(HEARTHSIDE_STYLE) as any
    badBands.terrain.contours.shoreline.bands.pop()
    expect(() => readHearthsideStyle(badBands)).toThrow('reed wash and silt bank')

    const reversedBands = structuredClone(HEARTHSIDE_STYLE) as any
    reversedBands.terrain.contours.shoreline.bands.reverse()
    expect(() => readHearthsideStyle(reversedBands)).toThrow('reed wash before the silt bank')

    const badTint = structuredClone(HEARTHSIDE_STYLE) as any
    badTint.terrain.contours.shoreline.bands[0].tint = 'orange'
    expect(() => readHearthsideStyle(badTint)).toThrow('bands[0].tint is unknown')

    const badOpacity = structuredClone(HEARTHSIDE_STYLE) as any
    badOpacity.terrain.contours.shoreline.bands[1].opacity = 1.1
    expect(() => readHearthsideStyle(badOpacity)).toThrow('bands[1].opacity must be at most one')
  })

  it('requires unit-range terrain fill opacity and keeps the road uniquely blended', () => {
    expect(HEARTHSIDE_STYLE.terrain.fills.road?.opacity).toBe(0.58)
    expect(
      Object.entries(HEARTHSIDE_STYLE.terrain.fills)
        .filter(([name]) => name !== 'road')
        .map(([, fill]) => fill.opacity),
    ).toEqual(Array(9).fill(1))

    const missingOpacity = structuredClone(HEARTHSIDE_STYLE) as any
    delete missingOpacity.terrain.fills.road.opacity
    expect(() => readHearthsideStyle(missingOpacity)).toThrow('fills.road keys')

    const invalidOpacity = structuredClone(HEARTHSIDE_STYLE) as any
    invalidOpacity.terrain.fills.road.opacity = 1.01
    expect(() => readHearthsideStyle(invalidOpacity)).toThrow('fills.road.opacity')
  })

  it('rejects unknown manifest frames, palette tints, and phase keys', () => {
    const badFrame = structuredClone(HEARTHSIDE_STYLE)
    const fills = badFrame.terrain.fills as Record<string, TerrainFillTreatment>
    fills.ground = { frames: ['missingFrame'], tint: 'reed', opacity: 1 }
    expect(() => readHearthsideStyle(badFrame)).toThrow('frames[0] is unknown')

    const badTint = structuredClone(HEARTHSIDE_STYLE)
    const tintFills = badTint.terrain.fills as Record<
      string,
      { frames: readonly string[]; tint: string; opacity: number }
    >
    tintFills.ground = { frames: ['washA'], tint: 'orange', opacity: 1 }
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
