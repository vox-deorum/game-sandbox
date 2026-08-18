import { describe, expect, it } from 'vitest'

import {
  HEARTHSIDE_STYLE,
  measureDeliveryGap,
  propEffectAnchor,
  readHearthsideStyle,
  type TerrainFillTreatment,
  transitionDurationMs,
} from './presentation.js'

// The palette, curve profiles, seam calibration, route widths, and fill tints are presentation
// configuration that art passes are meant to move freely, so nothing here pins their values. What
// the suite guards is the reader: every malformed shape below must still be rejected.
describe('Hearthside Ink presentation', () => {
  it('rejects incomplete or out-of-frame monument calibration', () => {
    const missingFoundation = structuredClone(HEARTHSIDE_STYLE) as any
    delete missingFoundation.props.monumentByType.bell.sourceAnchorByRole.foundation
    expect(() => readHearthsideStyle(missingFoundation)).toThrow('sourceAnchorByRole keys')

    const offFrame = structuredClone(HEARTHSIDE_STYLE) as any
    offFrame.props.monumentByType.pump.sourceAnchorByRole.still.x = 769
    expect(() => readHearthsideStyle(offFrame)).toThrow(
      'must be inside a 768 by 512 monument frame',
    )
  })

  it('anchors the lantern light above the footprint and rejects an out-of-range anchor', () => {
    expect(propEffectAnchor('lantern').x).toBe(0)
    expect(propEffectAnchor('lantern').y).toBeLessThan(0)

    const offAnchor = structuredClone(HEARTHSIDE_STYLE) as any
    offAnchor.props.effectAnchorByType.lantern.y = -129
    expect(() => readHearthsideStyle(offAnchor)).toThrow('effectAnchorByType.lantern.y')
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

    const missingCornerRadius = structuredClone(HEARTHSIDE_STYLE) as any
    delete missingCornerRadius.terrain.contours.profiles.land.cornerRadiusCells
    expect(() => readHearthsideStyle(missingCornerRadius)).toThrow('profiles.land keys')

    const excessiveDeviation = structuredClone(HEARTHSIDE_STYLE) as any
    excessiveDeviation.terrain.contours.maxDeviationCells = 0.76
    expect(() => readHearthsideStyle(excessiveDeviation)).toThrow(
      'maxDeviationCells must be greater than 0 and at most 0.75',
    )

    const excessiveAmplitude = structuredClone(HEARTHSIDE_STYLE) as any
    excessiveAmplitude.terrain.contours.profiles.water.octaves[0].amplitudeCells = 4.01
    expect(() => readHearthsideStyle(excessiveAmplitude)).toThrow('amplitudeCells')

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

  it('rejects malformed role-keyed roof frames', () => {
    const unknownRole = structuredClone(HEARTHSIDE_STYLE) as any
    unknownRole.roofs.frames.home.mode = 'gable'
    expect(() => readHearthsideStyle(unknownRole)).toThrow('roofs.frames.home keys do not match')

    const unknownFrame = structuredClone(HEARTHSIDE_STYLE) as any
    unknownFrame.roofs.frames.inn.edge = 'missingFrame'
    expect(() => readHearthsideStyle(unknownFrame)).toThrow(
      'roofs.frames.inn.edge is unknown',
    )

    const emptyFills = structuredClone(HEARTHSIDE_STYLE) as any
    emptyFills.roofs.frames.shed.fills = []
    expect(() => readHearthsideStyle(emptyFills)).toThrow(
      'roofs.frames.shed.fills must contain at least one frame',
    )

    const extraBuilding = structuredClone(HEARTHSIDE_STYLE) as any
    extraBuilding.roofs.frames.barn = {
      fills: ['homeFill', 'homeFillAlt'],
      edge: 'homeEdge',
      corner: 'homeCorner',
      ridge: 'homeRidge',
    }
    expect(() => readHearthsideStyle(extraBuilding)).toThrow(
      'roofs.frames keys do not match its contract',
    )
  })

  it('keeps every terrain fill and route opaque', () => {
    expect(HEARTHSIDE_STYLE.terrain.fills.road?.opacity).toBe(1)
    expect(HEARTHSIDE_STYLE.terrain.routes.road.opacity).toBe(1)
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

    const excessiveCornerRadius = structuredClone(HEARTHSIDE_STYLE) as any
    excessiveCornerRadius.terrain.routes.path.curve.cornerRadiusCells = 4.01
    expect(() => readHearthsideStyle(excessiveCornerRadius)).toThrow('cornerRadiusCells')

    const unaffordableCornerRadius = structuredClone(HEARTHSIDE_STYLE) as any
    unaffordableCornerRadius.terrain.routes.path.curve.cornerRadiusCells = 3.5
    unaffordableCornerRadius.terrain.routes.path.curve.sampleSpacingCells = 0.1
    expect(() => readHearthsideStyle(unaffordableCornerRadius)).toThrow('more than the 256 allowed')

    const extraCurveKey = structuredClone(HEARTHSIDE_STYLE) as any
    extraCurveKey.terrain.routes.road.curve.mode = 'macro'
    expect(() => readHearthsideStyle(extraCurveKey)).toThrow('road.curve keys')

    const invalidOpacity = structuredClone(HEARTHSIDE_STYLE) as any
    invalidOpacity.terrain.routes.road.opacity = 1.01
    expect(() => readHearthsideStyle(invalidOpacity)).toThrow('routes.road.opacity')
  })

  it('rejects unknown manifest frames and palette tints', () => {
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

  it('rejects expression frames absent from the effects page and an invalid frame ratio', () => {
    const badFrame = structuredClone(HEARTHSIDE_STYLE) as any
    badFrame.expressions.frames.wave = 'missingFrame'
    expect(() => readHearthsideStyle(badFrame)).toThrow(
      'presentation.expressions.frames.wave is unknown',
    )

    const badAccent = structuredClone(HEARTHSIDE_STYLE) as any
    badAccent.expressions.accentFrames = ['missingAccent', 'expressionAccentB']
    expect(() => readHearthsideStyle(badAccent)).toThrow(
      'presentation.expressions.accentFrames[0] is unknown',
    )

    const zeroRatio = structuredClone(HEARTHSIDE_STYLE) as any
    zeroRatio.expressions.frameRatio = 0
    expect(() => readHearthsideStyle(zeroRatio)).toThrow(
      'expressions.frameRatio must be greater than 0',
    )

    const excessiveRatio = structuredClone(HEARTHSIDE_STYLE) as any
    excessiveRatio.expressions.frameRatio = 1.01
    expect(() => readHearthsideStyle(excessiveRatio)).toThrow('expressions.frameRatio')
  })

  it('rejects an expression frame set that is not exactly the emotes plus use', () => {
    const extraKey = structuredClone(HEARTHSIDE_STYLE) as any
    extraKey.expressions.frames.extra = 'expressionWave'
    expect(() => readHearthsideStyle(extraKey)).toThrow('frames keys do not match')

    const missingToken = structuredClone(HEARTHSIDE_STYLE) as any
    delete missingToken.expressions.frames.sleep
    expect(() => readHearthsideStyle(missingToken)).toThrow('frames keys do not match')
  })
})
