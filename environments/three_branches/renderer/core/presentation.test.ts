import { describe, expect, it } from 'vitest'

import {
  bellStrikerTreatment,
  HEARTHSIDE_STYLE,
  measureDeliveryGap,
  propEffectAnchor,
  readHearthsideStyle,
  smoothedDeliveryGapMs,
  type TerrainFillTreatment,
  transitionDurationMs,
} from './presentation.js'

type MutableOpacityAnimation = {
  mode: string
  min: number
  max: number
  periodTicks: number
  [key: string]: unknown
}

type MutableOpacityAnimationDocument = {
  propEffects: {
    shrine: {
      opacityAnimation: MutableOpacityAnimation
    }
  }
}

function mutableOpacityAnimationDocument(): MutableOpacityAnimationDocument {
  return structuredClone(HEARTHSIDE_STYLE) as unknown as MutableOpacityAnimationDocument
}

// The palette, curve profiles, seam calibration, route widths, and fill tints are presentation
// configuration that art passes are meant to move freely, so nothing here pins their values. What
// the suite guards is the reader: every malformed shape below must still be rejected.
describe('Hearthside Ink presentation', () => {
  it('keeps the configured thumbnail in the validated presentation document', () => {
    expect(HEARTHSIDE_STYLE.thumbnail).toEqual({
      source: './assets/source-art/thumbnail-source.png',
      path: './assets/thumbnail.png',
      width: 320,
      height: 180,
      format: 'full-color',
    })

    const invalid = structuredClone(HEARTHSIDE_STYLE) as any
    invalid.thumbnail.format = 'grayscale-alpha'
    expect(() => readHearthsideStyle(invalid)).toThrow('thumbnail.format must be full-color')
  })

  it('defaults the lantern light anchor to the collision center', () => {
    expect(propEffectAnchor('lantern')).toEqual({ x: 0, y: 0 })
  })

  it('keeps the bell striker hinge and restrained swing in presentation calibration', () => {
    expect(bellStrikerTreatment()).toEqual({
      pivot: { x: 192, y: 39 },
      amplitudeRadians: 0.14,
      periodTicks: 8,
    })

    const outsideFrame = structuredClone(HEARTHSIDE_STYLE) as any
    outsideFrame.props.bellStriker.pivot.y = 256
    expect(() => readHearthsideStyle(outsideFrame)).toThrow('bellStriker.pivot')

    const excessiveAmplitude = structuredClone(HEARTHSIDE_STYLE) as any
    excessiveAmplitude.props.bellStriker.amplitudeRadians = Math.PI / 4 + 0.01
    expect(() => readHearthsideStyle(excessiveAmplitude)).toThrow('bellStriker.amplitudeRadians')

    const invalidPeriod = structuredClone(HEARTHSIDE_STYLE) as any
    invalidPeriod.props.bellStriker.periodTicks = 0
    expect(() => readHearthsideStyle(invalidPeriod)).toThrow('bellStriker.periodTicks')
  })

  it('validates optional prop-effect ping-pong opacity animation', () => {
    const valid = mutableOpacityAnimationDocument()
    valid.propEffects.shrine.opacityAnimation = {
      mode: 'pingPong',
      min: 0,
      max: 1,
      periodTicks: 24,
    }
    expect(readHearthsideStyle(valid).propEffects.shrine?.opacityAnimation).toEqual(
      valid.propEffects.shrine.opacityAnimation,
    )

    const invalidMode = structuredClone(valid)
    invalidMode.propEffects.shrine.opacityAnimation.mode = 'pulse'
    expect(() => readHearthsideStyle(invalidMode)).toThrow('opacityAnimation.mode')

    const invalidRange = structuredClone(valid)
    invalidRange.propEffects.shrine.opacityAnimation.max = 1.01
    expect(() => readHearthsideStyle(invalidRange)).toThrow('opacityAnimation.max')

    const negativeRange = structuredClone(valid)
    negativeRange.propEffects.shrine.opacityAnimation.min = -0.01
    expect(() => readHearthsideStyle(negativeRange)).toThrow('opacityAnimation.min')

    const reversedRange = structuredClone(valid)
    reversedRange.propEffects.shrine.opacityAnimation.min = 0.8
    reversedRange.propEffects.shrine.opacityAnimation.max = 0.2
    expect(() => readHearthsideStyle(reversedRange)).toThrow('opacityAnimation.min must be at most')

    const invalidPeriod = structuredClone(valid)
    invalidPeriod.propEffects.shrine.opacityAnimation.periodTicks = 0
    expect(() => readHearthsideStyle(invalidPeriod)).toThrow('opacityAnimation.periodTicks')

    const extraKey = structuredClone(valid)
    extraKey.propEffects.shrine.opacityAnimation.ease = 'linear'
    expect(() => readHearthsideStyle(extraKey)).toThrow('opacityAnimation keys do not match')
  })

  it('uses explicit host pace and scales unpaced delivery gaps by headroom, capped at natural', () => {
    expect(transitionDurationMs({ snap: true }, 400)).toBe(0)
    expect(transitionDurationMs({ transitionScale: 0 }, 400)).toBe(0)
    expect(transitionDurationMs({ transitionScale: 0.5 }, 900)).toBe(500)
    expect(transitionDurationMs(undefined, 240)).toBe(264)
    expect(transitionDurationMs(undefined, 1_400)).toBe(1_000)
    expect(transitionDurationMs()).toBe(1_000)
    expect(transitionDurationMs(undefined, Number.NaN)).toBe(1_000)
  })

  it('smooths the delivery gap with an EMA and applies headroom', () => {
    expect(smoothedDeliveryGapMs(null, 240)).toBe(240)
    expect(smoothedDeliveryGapMs(200, 240)).toBe(210)
    expect(smoothedDeliveryGapMs(220, 260)).toBe(230)
    expect(transitionDurationMs(undefined, 210)).toBeCloseTo(231)
    expect(transitionDurationMs(undefined, 10_000)).toBe(1_000)
  })

  it('requires a positive transition headroom', () => {
    const zeroHeadroom = structuredClone(HEARTHSIDE_STYLE) as any
    zeroHeadroom.transition.headroom = 0
    expect(() => readHearthsideStyle(zeroHeadroom)).toThrow('transition.headroom')

    const missingHeadroom = structuredClone(HEARTHSIDE_STYLE) as any
    delete missingHeadroom.transition.headroom
    expect(() => readHearthsideStyle(missingHeadroom)).toThrow('keys do not match')
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
    unknownTintMixKey.terrain.fills.reeds.tintMix = {
      tint: 'pine',
      amount: 0.25,
      mode: 'blend',
    }
    expect(() => readHearthsideStyle(unknownTintMixKey)).toThrow('tintMix keys do not match')

    const unknownTintMixTint = structuredClone(HEARTHSIDE_STYLE) as any
    unknownTintMixTint.terrain.fills.reeds.tintMix = { tint: 'orange', amount: 0.25 }
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

    const bridgeTaper = structuredClone(HEARTHSIDE_STYLE) as any
    bridgeTaper.terrain.seams.waterHatch.bridgeTaperCells = 0.35
    expect(() => readHearthsideStyle(bridgeTaper)).toThrow('waterHatch keys do not match')
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

  it('requires one matching full-roof frame for each building type', () => {
    const frameObject = structuredClone(HEARTHSIDE_STYLE) as any
    frameObject.roofs.frames.home = { frame: 'homeRoof' }
    expect(() => readHearthsideStyle(frameObject)).toThrow('roofs.frames.home is unknown')

    const unknownFrame = structuredClone(HEARTHSIDE_STYLE) as any
    unknownFrame.roofs.frames.inn = 'missingFrame'
    expect(() => readHearthsideStyle(unknownFrame)).toThrow('roofs.frames.inn is unknown')

    const extraBuilding = structuredClone(HEARTHSIDE_STYLE) as any
    extraBuilding.roofs.frames.barn = 'barnRoof'
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
    badPlank.terrain.planks.frame = 'missingFrame'
    expect(() => readHearthsideStyle(badPlank)).toThrow('planks.frame is unknown')
  })

  it('reads the full-color bridge deck treatment and rejects unsafe calibration', () => {
    expect(HEARTHSIDE_STYLE.terrain.planks).toMatchObject({
      frame: 'boards',
      boardsPerCell: 3,
      widthVariation: 0.1,
      portalOverlapCells: 0.5,
      sideOverhangCells: 0.05,
      sourceOverscanCells: 0.08,
      sourcePhaseCells: 0.04,
      portalSourceOverscanCells: 0.05,
      seam: { tint: 'backdrop', opacity: 0.35, widthCells: 0.025 },
    })

    const unknownKey = structuredClone(HEARTHSIDE_STYLE) as any
    unknownKey.terrain.planks.tint = 'backdrop'
    expect(() => readHearthsideStyle(unknownKey)).toThrow('planks keys do not match')

    const removedKey = structuredClone(HEARTHSIDE_STYLE) as any
    delete removedKey.terrain.planks.sourcePhaseCells
    expect(() => readHearthsideStyle(removedKey)).toThrow('planks keys do not match')

    const obsoleteKey = structuredClone(HEARTHSIDE_STYLE) as any
    obsoleteKey.terrain.planks.backingTint = 'wall'
    expect(() => readHearthsideStyle(obsoleteKey)).toThrow('planks keys do not match')

    const fractionalCount = structuredClone(HEARTHSIDE_STYLE) as any
    fractionalCount.terrain.planks.boardsPerCell = 2.5
    expect(() => readHearthsideStyle(fractionalCount)).toThrow(
      'boardsPerCell must be a positive integer',
    )

    const excessiveCount = structuredClone(HEARTHSIDE_STYLE) as any
    excessiveCount.terrain.planks.boardsPerCell = 9
    expect(() => readHearthsideStyle(excessiveCount)).toThrow('boardsPerCell must be at most eight')

    const invalidFrame = structuredClone(HEARTHSIDE_STYLE) as any
    invalidFrame.terrain.planks.frame = 'missing'
    expect(() => readHearthsideStyle(invalidFrame)).toThrow('planks.frame is unknown')

    const excessiveOverlap = structuredClone(HEARTHSIDE_STYLE) as any
    excessiveOverlap.terrain.planks.portalOverlapCells = 0.501
    expect(() => readHearthsideStyle(excessiveOverlap)).toThrow('portalOverlapCells')

    const maximumOverlap = structuredClone(HEARTHSIDE_STYLE) as any
    maximumOverlap.terrain.planks.portalOverlapCells = 0.5
    expect(readHearthsideStyle(maximumOverlap).terrain.planks.portalOverlapCells).toBe(0.5)

    const invalidOverhang = structuredClone(HEARTHSIDE_STYLE) as any
    invalidOverhang.terrain.planks.sideOverhangCells = -0.01
    expect(() => readHearthsideStyle(invalidOverhang)).toThrow('sideOverhangCells')

    const zeroOverlap = structuredClone(HEARTHSIDE_STYLE) as any
    zeroOverlap.terrain.planks.portalOverlapCells = 0
    zeroOverlap.terrain.planks.sideOverhangCells = 0
    expect(readHearthsideStyle(zeroOverlap).terrain.planks).toMatchObject({
      portalOverlapCells: 0,
      sideOverhangCells: 0,
    })

    const excessiveOverhang = structuredClone(HEARTHSIDE_STYLE) as any
    excessiveOverhang.terrain.planks.sideOverhangCells = 0.101
    expect(() => readHearthsideStyle(excessiveOverhang)).toThrow('sideOverhangCells')

    const maximumOverscan = structuredClone(HEARTHSIDE_STYLE) as any
    maximumOverscan.terrain.planks.sourceOverscanCells = 0.15
    maximumOverscan.terrain.planks.sourcePhaseCells = 0.075
    expect(readHearthsideStyle(maximumOverscan).terrain.planks).toMatchObject({
      sourceOverscanCells: 0.15,
      sourcePhaseCells: 0.075,
    })

    const zeroPhase = structuredClone(HEARTHSIDE_STYLE) as any
    zeroPhase.terrain.planks.sourcePhaseCells = 0
    zeroPhase.terrain.planks.portalSourceOverscanCells = 0
    expect(readHearthsideStyle(zeroPhase).terrain.planks).toMatchObject({
      sourcePhaseCells: 0,
      portalSourceOverscanCells: 0,
    })

    const zeroOverscan = structuredClone(HEARTHSIDE_STYLE) as any
    zeroOverscan.terrain.planks.sourceOverscanCells = 0
    expect(() => readHearthsideStyle(zeroOverscan)).toThrow('sourceOverscanCells')

    const excessivePhase = structuredClone(HEARTHSIDE_STYLE) as any
    excessivePhase.terrain.planks.sourcePhaseCells = 0.041
    expect(() => readHearthsideStyle(excessivePhase)).toThrow('sourcePhaseCells')

    const negativePhase = structuredClone(HEARTHSIDE_STYLE) as any
    negativePhase.terrain.planks.sourcePhaseCells = -0.001
    expect(() => readHearthsideStyle(negativePhase)).toThrow('sourcePhaseCells')

    const excessiveOverscan = structuredClone(HEARTHSIDE_STYLE) as any
    excessiveOverscan.terrain.planks.sourceOverscanCells = 0.151
    expect(() => readHearthsideStyle(excessiveOverscan)).toThrow('sourceOverscanCells')

    const excessivePortalOverscan = structuredClone(HEARTHSIDE_STYLE) as any
    excessivePortalOverscan.terrain.planks.portalSourceOverscanCells = 0.101
    expect(() => readHearthsideStyle(excessivePortalOverscan)).toThrow(
      'portalSourceOverscanCells',
    )

    const negativePortalOverscan = structuredClone(HEARTHSIDE_STYLE) as any
    negativePortalOverscan.terrain.planks.portalSourceOverscanCells = -0.001
    expect(() => readHearthsideStyle(negativePortalOverscan)).toThrow(
      'portalSourceOverscanCells',
    )

    const nonFiniteOverscan = structuredClone(HEARTHSIDE_STYLE) as any
    nonFiniteOverscan.terrain.planks.sourceOverscanCells = Number.NaN
    expect(() => readHearthsideStyle(nonFiniteOverscan)).toThrow(
      'sourceOverscanCells must be finite',
    )

    const infinitePhase = structuredClone(HEARTHSIDE_STYLE) as any
    infinitePhase.terrain.planks.sourcePhaseCells = Number.POSITIVE_INFINITY
    expect(() => readHearthsideStyle(infinitePhase)).toThrow('sourcePhaseCells must be finite')

    const invalidEdgeOpacity = structuredClone(HEARTHSIDE_STYLE) as any
    invalidEdgeOpacity.terrain.planks.seam.opacity = 1.01
    expect(() => readHearthsideStyle(invalidEdgeOpacity)).toThrow('seam.opacity')

    const invalidEdgeWidth = structuredClone(HEARTHSIDE_STYLE) as any
    invalidEdgeWidth.terrain.planks.seam.widthCells = 0
    expect(() => readHearthsideStyle(invalidEdgeWidth)).toThrow('seam.widthCells')

    const excessiveEdgeWidth = structuredClone(HEARTHSIDE_STYLE) as any
    excessiveEdgeWidth.terrain.planks.seam.widthCells = 0.051
    expect(() => readHearthsideStyle(excessiveEdgeWidth)).toThrow('seam.widthCells')
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

  it('requires four registered full-color cast sets with bounded arm registrations', () => {
    expect(HEARTHSIDE_STYLE.characters.cast.villagers).toHaveLength(3)
    expect(HEARTHSIDE_STYLE.characters.cast.visitor.leftArm.pivot).toEqual({ x: 49, y: 78 })
    expect(HEARTHSIDE_STYLE.characters.cast.visitor.rightArm.pivot).toEqual({ x: 143, y: 78 })

    const invalidPivot = structuredClone(HEARTHSIDE_STYLE) as any
    invalidPivot.characters.cast.visitor.leftArm.pivot.x = 192
    expect(() => readHearthsideStyle(invalidPivot)).toThrow('must be inside its 192 by 192')

    const invalidCount = structuredClone(HEARTHSIDE_STYLE) as any
    invalidCount.characters.cast.villagers.pop()
    expect(() => readHearthsideStyle(invalidCount)).toThrow('exactly three sets')

    const duplicateId = structuredClone(HEARTHSIDE_STYLE) as any
    duplicateId.characters.cast.villagers[1].id = duplicateId.characters.cast.villagers[0].id
    expect(() => readHearthsideStyle(duplicateId)).toThrow('must not repeat ids')
  })

  it('bounds the scripted character gait calibration', () => {
    const zero = structuredClone(HEARTHSIDE_STYLE) as any
    zero.characters.walk.armAmplitudeRadians = 0
    expect(readHearthsideStyle(zero).characters.walk.armAmplitudeRadians).toBe(0)

    const excessive = structuredClone(HEARTHSIDE_STYLE) as any
    excessive.characters.walk.armAmplitudeRadians = Math.PI / 2 + 0.01
    expect(() => readHearthsideStyle(excessive)).toThrow('armAmplitudeRadians')

    const excessiveTravel = structuredClone(HEARTHSIDE_STYLE) as any
    excessiveTravel.characters.walk.armTravelPixels = 12.01
    expect(() => readHearthsideStyle(excessiveTravel)).toThrow('armTravelPixels')

    const excessiveSway = structuredClone(HEARTHSIDE_STYLE) as any
    excessiveSway.characters.walk.bodySwayRadians = Math.PI / 16 + 0.01
    expect(() => readHearthsideStyle(excessiveSway)).toThrow('bodySwayRadians')

    const excessiveBob = structuredClone(HEARTHSIDE_STYLE) as any
    excessiveBob.characters.walk.bodyBobPixels = 4.01
    expect(() => readHearthsideStyle(excessiveBob)).toThrow('bodyBobPixels')
  })

  it('requires a positive walk dead zone below one', () => {
    const zeroDeadZone = structuredClone(HEARTHSIDE_STYLE) as any
    zeroDeadZone.characters.walk.deadZone = 0
    expect(() => readHearthsideStyle(zeroDeadZone)).toThrow(
      'characters.walk.deadZone must be greater than 0',
    )

    const excessiveDeadZone = structuredClone(HEARTHSIDE_STYLE) as any
    excessiveDeadZone.characters.walk.deadZone = 1.01
    expect(() => readHearthsideStyle(excessiveDeadZone)).toThrow(
      'characters.walk.deadZone must be greater than 0 and at most 1',
    )

    const missingDeadZone = structuredClone(HEARTHSIDE_STYLE) as any
    delete missingDeadZone.characters.walk.deadZone
    expect(() => readHearthsideStyle(missingDeadZone)).toThrow('keys do not match')
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
