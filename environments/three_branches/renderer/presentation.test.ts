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

const LAND_CURVE = {
  sampleSpacingCells: 0.25,
  smoothingPasses: 8,
  octaves: [
    { wavelengthCells: 8, amplitudeCells: 0.28 },
    { wavelengthCells: 3, amplitudeCells: 0.12 },
    { wavelengthCells: 1.2, amplitudeCells: 0.05 },
  ],
} as const

const WATER_CURVE = {
  sampleSpacingCells: 0.2,
  smoothingPasses: 10,
  octaves: [
    { wavelengthCells: 11, amplitudeCells: 0.34 },
    { wavelengthCells: 4, amplitudeCells: 0.14 },
    { wavelengthCells: 1.5, amplitudeCells: 0.06 },
  ],
} as const

const ROAD_CURVE = {
  sampleSpacingCells: 0.25,
  smoothingPasses: 10,
  octaves: [{ wavelengthCells: 6, amplitudeCells: 0.05 }],
} as const

const PATH_CURVE = {
  sampleSpacingCells: 0.2,
  smoothingPasses: 14,
  octaves: [{ wavelengthCells: 7, amplitudeCells: 0.04 }],
} as const

const APPROVED_CONTOURS = {
  profiles: { land: LAND_CURVE, water: WATER_CURVE },
  junctionTangentCells: 0.25,
  maxDeviationCells: 0.6,
  minimumCorridorCells: 0.45,
} as const

const APPROVED_SEAMS = {
  pooling: { widthCells: 0.45, darken: 0.16, opacity: 0.28 },
  ink: {
    tint: 'ink',
    widthCells: 0.15,
    opacity: 0.7,
    runLengthCells: [4, 9],
    gapLengthCells: [0.6, 1.7],
  },
  waterHatch: {
    tint: 'ink',
    widthCells: 0.1,
    offsetsCells: [0.55, 1.05],
    opacity: 0.3,
    bridgeTaperCells: 0.35,
  },
} as const

const APPROVED_ROUTES = {
  road: {
    curve: ROAD_CURVE,
    targetWidthCells: 2.1,
    minimumWidthCells: 1.6,
    opacity: 0.82,
  },
  path: { curve: PATH_CURVE, widthCells: 0.7, opacity: 1 },
} as const

const APPROVED_REED_MARKS = {
  tint: 'pine',
  widthCells: 0.05,
  lengthCells: [0.25, 0.5],
  perCell: 3,
  opacity: 0.5,
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

  it('pins the shared curve profiles, junction geometry, and seam calibration', () => {
    expect(HEARTHSIDE_STYLE.terrain.contours).toEqual(APPROVED_CONTOURS)
    expect(HEARTHSIDE_STYLE.terrain.seams).toEqual(APPROVED_SEAMS)
    expect(HEARTHSIDE_STYLE.terrain.reedMarks).toEqual(APPROVED_REED_MARKS)
    expect(HEARTHSIDE_STYLE.terrain.routes).toEqual(APPROVED_ROUTES)
    expect(HEARTHSIDE_STYLE.terrain.fills.road?.tint).toBe('timber')
    expect(HEARTHSIDE_STYLE.terrain.fills.road?.tint).not.toBe(
      HEARTHSIDE_STYLE.terrain.fills.field?.tint,
    )
    expect(HEARTHSIDE_STYLE.terrain.fills.road?.tint).not.toBe(
      HEARTHSIDE_STYLE.terrain.fills.path?.tint,
    )
  })

  it('uses bridge-over-water fills, reeds shaded toward pine, indigo wall fills, and timber planks', () => {
    const terrain = HEARTHSIDE_STYLE.terrain
    expect(terrain.fills.bridge).toEqual({
      frames: ['rippleA', 'rippleB', 'rippleC', 'rippleD'],
      tint: 'water',
      opacity: 1,
    })
    expect(terrain.fills.reeds).toEqual({
      frames: ['reedsA', 'reedsB', 'reedsC', 'reedsD'],
      tint: 'reed',
      tintMix: { tint: 'pine', amount: 0.45 },
      detailShift: 0.2,
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

  it('rejects an out-of-range fill detail shift, an invalid tint mix, and unknown fill keys', () => {
    const excessiveDetailShift = structuredClone(HEARTHSIDE_STYLE) as any
    excessiveDetailShift.terrain.fills.reeds.detailShift = 0.51
    expect(() => readHearthsideStyle(excessiveDetailShift)).toThrow('fills.reeds.detailShift')

    const unknownTintMixKey = structuredClone(HEARTHSIDE_STYLE) as any
    unknownTintMixKey.terrain.fills.reeds.tintMix.mode = 'blend'
    expect(() => readHearthsideStyle(unknownTintMixKey)).toThrow('tintMix keys do not match')

    const unknownTintMixTint = structuredClone(HEARTHSIDE_STYLE) as any
    unknownTintMixTint.terrain.fills.reeds.tintMix.tint = 'orange'
    expect(() => readHearthsideStyle(unknownTintMixTint)).toThrow('tintMix.tint is unknown')

    const extraFillKey = structuredClone(HEARTHSIDE_STYLE) as any
    extraFillKey.terrain.fills.ground.mode = 'wash'
    expect(() => readHearthsideStyle(extraFillKey)).toThrow('keys do not match its contract')
  })

  it('rejects invalid contour geometry and seam calibration', () => {
    const extraKey = structuredClone(HEARTHSIDE_STYLE) as any
    extraKey.terrain.contours.mode = 'tiles'
    expect(() => readHearthsideStyle(extraKey)).toThrow('keys do not match')

    const badSpacing = structuredClone(HEARTHSIDE_STYLE) as any
    badSpacing.terrain.contours.profiles.land.sampleSpacingCells = 4.01
    expect(() => readHearthsideStyle(badSpacing)).toThrow('sampleSpacingCells')

    const badWavelength = structuredClone(HEARTHSIDE_STYLE) as any
    badWavelength.terrain.contours.profiles.water.octaves[0].wavelengthCells = 256.01
    expect(() => readHearthsideStyle(badWavelength)).toThrow('wavelengthCells')

    const missingSmoothingPasses = structuredClone(HEARTHSIDE_STYLE) as any
    delete missingSmoothingPasses.terrain.contours.profiles.land.smoothingPasses
    expect(() => readHearthsideStyle(missingSmoothingPasses)).toThrow('profiles.land keys')

    const excessiveDeviation = structuredClone(HEARTHSIDE_STYLE) as any
    excessiveDeviation.terrain.contours.maxDeviationCells = 0.76
    expect(() => readHearthsideStyle(excessiveDeviation)).toThrow(
      'maxDeviationCells must be greater than 0 and at most 0.75',
    )

    const excessiveAmplitude = structuredClone(HEARTHSIDE_STYLE) as any
    excessiveAmplitude.terrain.contours.profiles.water.octaves[0].amplitudeCells = 4.01
    expect(() => readHearthsideStyle(excessiveAmplitude)).toThrow('amplitudeCells')

    const unsafeCorridor = structuredClone(HEARTHSIDE_STYLE) as any
    unsafeCorridor.terrain.contours.minimumCorridorCells = 0.249
    expect(() => readHearthsideStyle(unsafeCorridor)).toThrow('minimumCorridorCells')

    const extraSeamKey = structuredClone(HEARTHSIDE_STYLE) as any
    extraSeamKey.terrain.seams.mode = 'bands'
    expect(() => readHearthsideStyle(extraSeamKey)).toThrow('keys do not match')

    const excessivePoolingWidth = structuredClone(HEARTHSIDE_STYLE) as any
    excessivePoolingWidth.terrain.seams.pooling.widthCells = 2.01
    expect(() => readHearthsideStyle(excessivePoolingWidth)).toThrow('pooling.widthCells')

    const emptyOffsets = structuredClone(HEARTHSIDE_STYLE) as any
    emptyOffsets.terrain.seams.waterHatch.offsetsCells = []
    expect(() => readHearthsideStyle(emptyOffsets)).toThrow(
      'presentation.terrain.seams.waterHatch.offsetsCells must contain between one and four offsets.',
    )

    const tooManyOffsets = structuredClone(HEARTHSIDE_STYLE) as any
    tooManyOffsets.terrain.seams.waterHatch.offsetsCells = [0.2, 0.4, 0.6, 0.8, 1]
    expect(() => readHearthsideStyle(tooManyOffsets)).toThrow(
      'presentation.terrain.seams.waterHatch.offsetsCells must contain between one and four offsets.',
    )

    const badSeamTint = structuredClone(HEARTHSIDE_STYLE) as any
    badSeamTint.terrain.seams.ink.tint = 'orange'
    expect(() => readHearthsideStyle(badSeamTint)).toThrow('ink.tint is unknown')

    const reversedRunLength = structuredClone(HEARTHSIDE_STYLE) as any
    reversedRunLength.terrain.seams.ink.runLengthCells = [9, 4]
    expect(() => readHearthsideStyle(reversedRunLength)).toThrow('runLengthCells must be ordered')

    const excessiveBridgeTaper = structuredClone(HEARTHSIDE_STYLE) as any
    excessiveBridgeTaper.terrain.seams.waterHatch.bridgeTaperCells = 1.01
    expect(() => readHearthsideStyle(excessiveBridgeTaper)).toThrow('bridgeTaperCells')
  })

  it('rejects invalid reed mark calibration', () => {
    const extraKey = structuredClone(HEARTHSIDE_STYLE) as any
    extraKey.terrain.reedMarks.mode = 'scatter'
    expect(() => readHearthsideStyle(extraKey)).toThrow('reedMarks keys do not match')

    const excessivePerCell = structuredClone(HEARTHSIDE_STYLE) as any
    excessivePerCell.terrain.reedMarks.perCell = 9
    expect(() => readHearthsideStyle(excessivePerCell)).toThrow('perCell must be at most eight')

    const excessiveWidth = structuredClone(HEARTHSIDE_STYLE) as any
    excessiveWidth.terrain.reedMarks.widthCells = 0.6
    expect(() => readHearthsideStyle(excessiveWidth)).toThrow('reedMarks.widthCells')

    const reversedLength = structuredClone(HEARTHSIDE_STYLE) as any
    reversedLength.terrain.reedMarks.lengthCells = [0.5, 0.25]
    expect(() => readHearthsideStyle(reversedLength)).toThrow('lengthCells must be ordered')

    const unknownTint = structuredClone(HEARTHSIDE_STYLE) as any
    unknownTint.terrain.reedMarks.tint = 'orange'
    expect(() => readHearthsideStyle(unknownTint)).toThrow('reedMarks.tint is unknown')
  })

  it('keeps terrain fills opaque and gives the inset road its own blend', () => {
    expect(HEARTHSIDE_STYLE.terrain.fills.road?.opacity).toBe(1)
    expect(HEARTHSIDE_STYLE.terrain.routes.road.opacity).toBe(0.82)
    expect(Object.values(HEARTHSIDE_STYLE.terrain.fills).map((fill) => fill.opacity)).toEqual(
      Array(10).fill(1),
    )

    const missingOpacity = structuredClone(HEARTHSIDE_STYLE) as any
    delete missingOpacity.terrain.fills.road.opacity
    expect(() => readHearthsideStyle(missingOpacity)).toThrow('fills.road keys')

    const invalidOpacity = structuredClone(HEARTHSIDE_STYLE) as any
    invalidOpacity.terrain.fills.road.opacity = 1.01
    expect(() => readHearthsideStyle(invalidOpacity)).toThrow('fills.road.opacity')
  })

  it('rejects unknown route keys, unsafe widths, and invalid route curve profiles', () => {
    const extraKey = structuredClone(HEARTHSIDE_STYLE) as any
    extraKey.terrain.routes.mode = 'centerline'
    expect(() => readHearthsideStyle(extraKey)).toThrow('routes keys do not match')

    const duplicateDeckWidths = structuredClone(HEARTHSIDE_STYLE) as any
    duplicateDeckWidths.terrain.routes.decks = { roadWidthCells: 2.1, pathWidthCells: 0.7 }
    expect(() => readHearthsideStyle(duplicateDeckWidths)).toThrow('routes keys do not match')

    const reversedRoadWidths = structuredClone(HEARTHSIDE_STYLE) as any
    reversedRoadWidths.terrain.routes.road.minimumWidthCells = 2.2
    expect(() => readHearthsideStyle(reversedRoadWidths)).toThrow('minimumWidthCells')

    const excessivePathWidth = structuredClone(HEARTHSIDE_STYLE) as any
    excessivePathWidth.terrain.routes.path.widthCells = 2.01
    expect(() => readHearthsideStyle(excessivePathWidth)).toThrow('path.widthCells')

    const excessiveSmoothingPasses = structuredClone(HEARTHSIDE_STYLE) as any
    excessiveSmoothingPasses.terrain.routes.path.curve.smoothingPasses = 257
    expect(() => readHearthsideStyle(excessiveSmoothingPasses)).toThrow(
      'smoothingPasses must be at most 256',
    )

    const extraCurveKey = structuredClone(HEARTHSIDE_STYLE) as any
    extraCurveKey.terrain.routes.road.curve.mode = 'macro'
    expect(() => readHearthsideStyle(extraCurveKey)).toThrow('road.curve keys')

    const invalidOpacity = structuredClone(HEARTHSIDE_STYLE) as any
    invalidOpacity.terrain.routes.road.opacity = 1.01
    expect(() => readHearthsideStyle(invalidOpacity)).toThrow('routes.road.opacity')
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

  it('requires the character walk frame ratio to fit within one recorded tick', () => {
    const zeroRatio = structuredClone(HEARTHSIDE_STYLE)
    zeroRatio.characters.walk.frameRatio = 0
    expect(() => readHearthsideStyle(zeroRatio)).toThrow(
      'characters.walk.frameRatio must be greater than 0',
    )

    const excessiveRatio = structuredClone(HEARTHSIDE_STYLE)
    excessiveRatio.characters.walk.frameRatio = 1.01
    expect(() => readHearthsideStyle(excessiveRatio)).toThrow(
      'characters.walk.frameRatio must be greater than 0 and at most 1',
    )
  })
})
