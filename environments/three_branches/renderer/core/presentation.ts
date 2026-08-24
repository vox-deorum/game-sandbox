import { type RenderOptions, transitionScaleOf } from '@renderers/types.js'
import presentationDocument from '../assets/presentation.json'
import {
  readThreeBranchesAssetCatalog,
  readThreeBranchesThumbnailAsset,
  type ThreeBranchesAtlasDraft,
  type ThreeBranchesThumbnailAsset,
} from '../assets.js'
import { smoothingPassesFor } from '../terrain/terrain-curves.js'
import { CATALOG, RULES } from '../ui/overlay.js'
import { mixedTint } from '../ui/tint.js'
import type { TerrainCurveProfile } from './types.js'
import {
  array,
  finiteNumber,
  nonnegativeInteger,
  positiveInteger,
  positiveNumber,
} from './validation.js'

/** Logical dimensions exposed to the renderer host. */
export interface RendererSize {
  /** Logical canvas width. */
  width: number
  /** Logical canvas height. */
  height: number
}

/** Canvas and camera values that remain TypeScript-owned renderer mechanics. */
export interface ThreeBranchesPresentation {
  /** Fixed logical surface advertised to the host. */
  internalSize: RendererSize
  /** Height of the fixed chrome strip. */
  chromeHeight: number
  /** Renderer world units used for one configured metre. */
  unitsPerMetre: number
  /** World-space padding used to derive camera limits. */
  cameraPadding: number
  /** Maximum zoom expressed as a multiple of fitted zoom. */
  maxZoomFactor: number
  /** Visitor-focused opening zoom expressed as a multiple of fitted zoom. */
  focusZoomFactor: number
  /** Fitted-zoom multiple at which nameplates reach full opacity. */
  nameplateZoomFactor: number
  /** Fitted-zoom multiples spanned by the nameplate fade below that factor. */
  nameplateFadeFactor: number
  /** Fitted-zoom multiple below which characters draw in the simplified non-texture mode. */
  farMarkZoomFactor: number
  /** Milliseconds a delivered line holds at full opacity. */
  speechHoldMs: number
  /** Milliseconds a delivered line takes to fade out after its hold. */
  speechFadeMs: number
  /** Longest wrapped line count a speech bubble draws before eliding. */
  speechMaxLines: number
}

/** Fixed renderer mechanics that are not Hearthside Ink art calibration. */
export const THREE_BRANCHES_PRESENTATION: ThreeBranchesPresentation = {
  internalSize: { width: 1200, height: 1000 },
  chromeHeight: 54,
  unitsPerMetre: 16,
  cameraPadding: 20,
  maxZoomFactor: 16,
  focusZoomFactor: 4,
  nameplateZoomFactor: 1.5,
  nameplateFadeFactor: 0.5,
  farMarkZoomFactor: 3.5,
  speechHoldMs: 4000,
  speechFadeMs: 600,
  speechMaxLines: 4,
} as const

/** Shared type size for the fixed information strip and live action controls. */
export const HUD_FONT_SIZE = 20

/** Semantic diagnostic colors used by chrome, collision, and the pre-art fallback. */
export interface ThreeBranchesPalette {
  /** Canvas backdrop. */
  backdrop: string
  /** Primary label color. */
  text: string
  /** Ordinary ground. */
  ground: string
  /** Road ground. */
  road: string
  /** Footpath ground. */
  path: string
  /** Bridge ground. */
  bridge: string
  /** Building interior ground. */
  interior: string
  /** Open doorway ground. */
  doorway: string
  /** Field ground. */
  field: string
  /** Reeds ground. */
  reeds: string
  /** Water ground. */
  water: string
  /** Building wall ground. */
  wall: string
  /** Semantic building outline. */
  building: string
  /** Interactive prop fill. */
  prop: string
  /** Solid scenery fill. */
  scenery: string
  /** Visitor body fill. */
  visitor: string
  /** NPC body fill. */
  npc: string
  /** Impassable-ground collision color. */
  blockedCollision: string
  /** Prop and scenery collision color. */
  objectCollision: string
  /** Character-body collision color. */
  characterCollision: string
  /** World-boundary collision color. */
  boundaryCollision: string
}

/** Diagnostic palette retained when artwork is unavailable and for ungraded renderer chrome. */
export const PALETTE: ThreeBranchesPalette = {
  backdrop: '#17211f',
  text: '#f5f3ea',
  ground: '#718760',
  road: '#b58a5a',
  path: '#c4aa78',
  bridge: '#8b6b4d',
  interior: '#c6b78f',
  doorway: '#d8c690',
  field: '#8c9550',
  reeds: '#5f8067',
  water: '#39758f',
  wall: '#4a4038',
  building: '#6a4d3a',
  prop: '#d99b45',
  scenery: '#4f7454',
  visitor: '#f1c75b',
  npc: '#e8e1d4',
  blockedCollision: '#ff5c5c',
  objectCollision: '#ffd166',
  characterCollision: '#66e3ff',
  boundaryCollision: '#ff4fd8',
} as const

export const HEARTHSIDE_PALETTE_KEYS = [
  'backdrop',
  'parchment',
  'bone',
  'ink',
  'reed',
  'silt',
  'water',
  'pine',
  'indigo',
  'cinnabar',
  'gilt',
  'violet',
  'timber',
  'ground',
  'road',
  'path',
  'field',
  'bank',
  'stream',
  'floor',
  'wall',
] as const

export type HearthsidePaletteKey = (typeof HEARTHSIDE_PALETTE_KEYS)[number]
export type HearthsidePalette = Readonly<Record<HearthsidePaletteKey, string>>

export interface FrameTreatment {
  frames: readonly string[]
  tint: HearthsidePaletteKey
}

/**
 * A terrain fill can blend with the full ground layer beneath it, deepen its grain contrast past
 * the seven percent default, and shade its tint toward a second palette color.
 */
export interface TerrainFillTreatment extends FrameTreatment {
  opacity: number
  /** Opacity of the half-cell-offset pattern pass. Defaults to the shared 0.5 treatment. */
  offsetPassOpacity?: number
  detailShift?: number
  tintMix?: {
    tint: HearthsidePaletteKey
    amount: number
  }
}

/** Deterministic short stalk strokes scattered inside reed cells. */
export interface TerrainReedMarksTreatment {
  tint: HearthsidePaletteKey
  widthCells: number
  lengthCells: readonly [number, number]
  perCell: number
  opacity: number
}

/** Deterministic subcell geometry calibration for natural terrain partitions. */
export interface TerrainContourTreatment {
  profiles: {
    land: TerrainCurveProfile
    water: TerrainCurveProfile
  }
  junctionTangentCells: number
  maxDeviationCells: number
}

/** Watercolor pooling, broken ink lines, and water hatching drawn along natural seams. */
export interface TerrainSeamTreatment {
  pooling: {
    widthCells: number
    darken: number
    opacity: number
  }
  ink: {
    tint: HearthsidePaletteKey
    widthCells: number
    opacity: number
    runLengthCells: readonly [number, number]
    gapLengthCells: readonly [number, number]
  }
  waterHatch: {
    tint: HearthsidePaletteKey
    widthCells: number
    offsetsCells: readonly number[]
    opacity: number
  }
}

export interface TerrainRouteTreatment {
  road: {
    curve: TerrainCurveProfile
    targetWidthCells: number
    minimumWidthCells: number
    edgeFadeCells: number
    opacity: number
  }
  path: {
    curve: TerrainCurveProfile
    widthCells: number
    edgeFadeCells: number
    opacity: number
  }
}

/** Semantic bridge deck frames selected once per connected bridge component. */
export interface PlankTreatment {
  frame: string
  boardsPerCell: number
  widthVariation: number
  portalOverlapCells: number
  portalMaskInsetCells: number
  sideOverhangCells: number
  sourceOverscanCells: number
  sourcePhaseCells: number
  seam: {
    tint: HearthsidePaletteKey
    opacity: number
    widthCells: number
  }
  edgeShadow: {
    tint: HearthsidePaletteKey
    opacity: number
    widthCells: number
  }
}

/** A restrained affine colour treatment applied to a world composite. */
export interface ColorGradeTreatment {
  brightness: number
  contrast: number
  saturation: number
  tint: HearthsidePaletteKey
  tintMix: number
}

export interface TextureOutlineLayerTreatment {
  scaleFactor: number
  opacity: number
}

/** A centered, texture-shaped edge treatment that blends props into the world. */
export interface TextureOutlineTreatment {
  tint: HearthsidePaletteKey
  layers: readonly TextureOutlineLayerTreatment[]
}

/** Validated art and motion calibration owned by presentation.json. */
interface VisualScaleTreatment {
  defaultScale: number
  scaleByType: Readonly<Record<string, number>>
}

export interface SourceAnchor {
  x: number
  y: number
}

/** An absolute pixel position inside a registered character source frame. */
export interface SourcePixelAnchor {
  x: number
  y: number
}

/** The calibrated rotating hinge and travel for the bell's single full-cell striker. */
export interface BellStrikerTreatment {
  pivot: SourcePixelAnchor
  amplitudeRadians: number
  periodTicks: number
}

/** One full-color arm sprite registered to a static cast base. */
export interface CharacterArmTreatment {
  frame: string
  pivot: SourcePixelAnchor
  anchor: SourcePixelAnchor
}

/** One deterministic full-color character cast set. */
export interface CharacterCastSet {
  id: string
  base: string
  leftArm: CharacterArmTreatment
  rightArm: CharacterArmTreatment
  farMarkTint: HearthsidePaletteKey
}

interface PropVisualTreatment extends VisualScaleTreatment {
  effectAnchorByType: Readonly<Record<string, SourceAnchor>>
  bellStriker: BellStrikerTreatment
}

/** A reusable, seek-safe opacity cycle applied to an active prop effect. */
export interface PropEffectOpacityAnimation {
  mode: 'pingPong'
  min: number
  max: number
  periodTicks: number
}

export interface PropEffectTreatment {
  frames: readonly string[]
  frameRate: number
  opacityAnimation?: PropEffectOpacityAnimation
}

export interface HearthsideStyle {
  /** The validated config-owned atlas definitions, retained for round-trip validation. */
  atlases: unknown
  thumbnail: ThreeBranchesThumbnailAsset
  palette: HearthsidePalette
  transition: { naturalMs: number; settleGraceMs: number; headroom: number }
  terrain: {
    fills: Readonly<Record<string, TerrainFillTreatment>>
    contours: TerrainContourTreatment
    seams: TerrainSeamTreatment
    reedMarks: TerrainReedMarksTreatment
    routes: TerrainRouteTreatment
    planks: PlankTreatment
    upperWall: FrameTreatment
  }
  roofs: {
    clearAlpha: number
    fadeMs: number
    frames: Readonly<Record<string, string>>
  }
  postEffects: {
    nightGrade: ColorGradeTreatment
    textureOutline: TextureOutlineTreatment
  }
  characters: {
    cast: { visitor: CharacterCastSet; villagers: readonly CharacterCastSet[] }
    walk: {
      frameRatio: number
      deadZone: number
      armAmplitudeRadians: number
      armTravelPixels: number
      bodySwayRadians: number
      bodyBobPixels: number
    }
  }
  props: PropVisualTreatment
  scenery: VisualScaleTreatment
  propEffects: Readonly<Record<string, PropEffectTreatment>>
  emissives: { lantern: HearthsidePaletteKey; hearth: HearthsidePaletteKey; frame: string }
  cranes: {
    frames: readonly string[]
    tint: HearthsidePaletteKey
    count: readonly [number, number]
    frameMs: number
  }
  expressions: {
    frames: Readonly<Record<string, string>>
    activityFrames: Readonly<Record<string, string>>
    tint: HearthsidePaletteKey
    accentFrames: readonly string[]
    frameRatio: number
    worldLabel: {
      fontSize: number
      characterWidth: number
      lineHeight: number
      paddingX: number
      paddingY: number
      iconSlotWidth: number
      iconFrameWidth: number
    }
    inputPalette: {
      plateWidth: number
      plateHeight: number
      gap: number
      contentMargin: number
      labelFontSize: number
      iconFrameWidth: number
      iconContentWidth: number
      iconStartX: number
      iconLabelGap: number
    }
  }
}

/** The single validated Hearthside Ink configuration used by artwork and tests. */
export const HEARTHSIDE_STYLE = readHearthsideStyle(presentationDocument)

/** Resolve configured ground semantics to diagnostic paint without making codes authoritative. */
export function groundColor(name: string): string {
  return PALETTE[name as keyof typeof PALETTE] ?? PALETTE.ground
}

/** Resolve one transition duration from transport timing and the natural presentation duration. */
export function transitionDurationMs(
  options?: RenderOptions,
  deliveryGapMs?: number | null,
  style: Pick<HearthsideStyle, 'transition'> = HEARTHSIDE_STYLE,
): number {
  if (options?.snap === true) return 0
  if (options?.transitionScale !== undefined) {
    return style.transition.naturalMs * transitionScaleOf(options)
  }
  return deliveryGapMs !== undefined &&
    deliveryGapMs !== null &&
    Number.isFinite(deliveryGapMs) &&
    deliveryGapMs >= 0
    ? Math.min(deliveryGapMs * style.transition.headroom, style.transition.naturalMs)
    : style.transition.naturalMs
}

/** Smooth one measured delivery gap into the running estimate, giving recent gaps the most weight. */
export function smoothedDeliveryGapMs(
  previousEstimateMs: number | null,
  measuredGapMs: number,
): number {
  if (previousEstimateMs === null) return measuredGapMs
  return previousEstimateMs * 0.75 + measuredGapMs * 0.25
}

/** Measure only consecutive unpaced deliveries, resetting the clock across snaps and paced hosts. */
export function measureDeliveryGap(
  previousMs: number | null,
  deliveredAtMs: number,
  options?: RenderOptions,
): { gapMs: number | undefined; nextMs: number | null } {
  if (options?.snap === true || options?.transitionScale !== undefined) {
    return { gapMs: undefined, nextMs: null }
  }
  return {
    gapMs: previousMs === null ? undefined : deliveredAtMs - previousMs,
    nextMs: deliveredAtMs,
  }
}

/** Resolve one complete prop-still scale from the validated visual calibration. */
export function propVisualScale(type: string): number {
  return visualScaleFor(type, HEARTHSIDE_STYLE.props)
}

/** Resolve an effect anchor measured from the center of a complete prop source canvas. */
export function propEffectAnchor(type: string): SourceAnchor {
  return HEARTHSIDE_STYLE.props.effectAnchorByType[type] ?? { x: 0, y: 0 }
}

/** Resolve the source-frame hinge and angular travel for the bell striker. */
export function bellStrikerTreatment(): BellStrikerTreatment {
  return HEARTHSIDE_STYLE.props.bellStriker
}

/** Resolve one scenery sprite scale from the validated visual calibration. */
export function sceneryVisualScale(type: string): number {
  return visualScaleFor(type, HEARTHSIDE_STYLE.scenery)
}

/** Validate an injected document for tests and future configuration edits. */
export function readHearthsideStyle(value: unknown): HearthsideStyle {
  const source = exactRecord(value, 'presentation', [
    'atlases',
    'thumbnail',
    'palette',
    'transition',
    'terrain',
    'roofs',
    'postEffects',
    'characters',
    'props',
    'scenery',
    'propEffects',
    'emissives',
    'cranes',
    'expressions',
  ])
  const atlases = readThreeBranchesAssetCatalog(source.atlases)
  const thumbnail = readThreeBranchesThumbnailAsset(source.thumbnail)
  const paletteSource = exactRecord(source.palette, 'presentation.palette', HEARTHSIDE_PALETTE_KEYS)
  const palette = Object.fromEntries(
    HEARTHSIDE_PALETTE_KEYS.map((key) => [
      key,
      hex(paletteSource[key], `presentation.palette.${key}`),
    ]),
  ) as Record<HearthsidePaletteKey, string>
  const paletteNames = new Set<string>(HEARTHSIDE_PALETTE_KEYS)

  const transitionSource = exactRecord(source.transition, 'presentation.transition', [
    'naturalMs',
    'settleGraceMs',
    'headroom',
  ])
  const transition = {
    naturalMs: positiveNumber(transitionSource.naturalMs, 'presentation.transition.naturalMs'),
    settleGraceMs: nonnegativeNumber(
      transitionSource.settleGraceMs,
      'presentation.transition.settleGraceMs',
    ),
    headroom: positiveNumber(transitionSource.headroom, 'presentation.transition.headroom'),
  }

  const terrainFrames = framesFor(atlases, 'terrain')
  const bridgeFrames = framesFor(atlases, 'bridges')
  const terrainSource = exactRecord(source.terrain, 'presentation.terrain', [
    'fills',
    'contours',
    'seams',
    'reedMarks',
    'routes',
    'planks',
    'upperWall',
  ])
  const groundNames = RULES.grounds.map((ground) => ground.name)
  const fillsSource = exactRecord(terrainSource.fills, 'presentation.terrain.fills', groundNames)
  const fills = Object.fromEntries(
    groundNames.map((name) => [
      name,
      terrainFillTreatment(
        fillsSource[name],
        `presentation.terrain.fills.${name}`,
        terrainFrames,
        paletteNames,
      ),
    ]),
  )
  const routes = routeTreatment(terrainSource.routes, 'presentation.terrain.routes')
  const terrain = {
    fills,
    contours: contourTreatment(terrainSource.contours, 'presentation.terrain.contours'),
    seams: seamTreatment(terrainSource.seams, 'presentation.terrain.seams', paletteNames),
    reedMarks: reedMarksTreatment(
      terrainSource.reedMarks,
      'presentation.terrain.reedMarks',
      paletteNames,
    ),
    routes,
    planks: plankTreatment(
      terrainSource.planks,
      'presentation.terrain.planks',
      bridgeFrames,
      paletteNames,
    ),
    upperWall: frameTreatment(
      terrainSource.upperWall,
      'presentation.terrain.upperWall',
      terrainFrames,
      paletteNames,
    ),
  }

  const roofsSource = exactRecord(source.roofs, 'presentation.roofs', [
    'clearAlpha',
    'fadeMs',
    'frames',
  ])
  const roofFramesSource = exactRecord(
    roofsSource.frames,
    'presentation.roofs.frames',
    CATALOG.buildings.map((building) => building.token),
  )
  const roofs = {
    clearAlpha: unitNumber(roofsSource.clearAlpha, 'presentation.roofs.clearAlpha'),
    fadeMs: positiveNumber(roofsSource.fadeMs, 'presentation.roofs.fadeMs'),
    frames: Object.fromEntries(
      Object.entries(roofFramesSource).map(([name, frameValue]) => [
        name,
        knownText(
          frameValue,
          framesFor(atlases, 'buildings', name),
          `presentation.roofs.frames.${name}`,
        ),
      ]),
    ),
  }

  const postEffectsSource = exactRecord(source.postEffects, 'presentation.postEffects', [
    'nightGrade',
    'textureOutline',
  ])
  const postEffects = {
    nightGrade: colorGradeTreatment(
      postEffectsSource.nightGrade,
      'presentation.postEffects.nightGrade',
      paletteNames,
    ),
    textureOutline: textureOutlineTreatment(
      postEffectsSource.textureOutline,
      'presentation.postEffects.textureOutline',
      paletteNames,
    ),
  }

  const charactersSource = exactRecord(source.characters, 'presentation.characters', [
    'cast',
    'walk',
  ])
  const characterFrames = framesFor(atlases, 'characters')
  const castSource = exactRecord(charactersSource.cast, 'presentation.characters.cast', [
    'visitor',
    'villagers',
  ])
  const visitor = characterCastSet(
    castSource.visitor,
    'presentation.characters.cast.visitor',
    characterFrames,
    paletteNames,
  )
  const villagersSource = array(castSource.villagers, 'presentation.characters.cast.villagers')
  if (villagersSource.length !== 3) {
    throw new Error('presentation.characters.cast.villagers must contain exactly three sets.')
  }
  const villagers = villagersSource.map((value, index) =>
    characterCastSet(
      value,
      `presentation.characters.cast.villagers[${index}]`,
      characterFrames,
      paletteNames,
    ),
  )
  if (new Set(villagers.map((set) => set.id)).size !== villagers.length) {
    throw new Error('presentation.characters.cast.villagers must not repeat ids.')
  }
  const walkSource = exactRecord(charactersSource.walk, 'presentation.characters.walk', [
    'frameRatio',
    'deadZone',
    'armAmplitudeRadians',
    'armTravelPixels',
    'bodySwayRadians',
    'bodyBobPixels',
  ])
  const characters = {
    cast: { visitor, villagers },
    walk: {
      frameRatio: boundedNumber(
        walkSource.frameRatio,
        'presentation.characters.walk.frameRatio',
        0,
        1,
      ),
      deadZone: boundedNumber(walkSource.deadZone, 'presentation.characters.walk.deadZone', 0, 1),
      armAmplitudeRadians: boundedNumber(
        walkSource.armAmplitudeRadians,
        'presentation.characters.walk.armAmplitudeRadians',
        0,
        Math.PI / 2,
        true,
      ),
      armTravelPixels: boundedNumber(
        walkSource.armTravelPixels,
        'presentation.characters.walk.armTravelPixels',
        0,
        12,
        true,
      ),
      bodySwayRadians: boundedNumber(
        walkSource.bodySwayRadians,
        'presentation.characters.walk.bodySwayRadians',
        0,
        Math.PI / 16,
        true,
      ),
      bodyBobPixels: boundedNumber(
        walkSource.bodyBobPixels,
        'presentation.characters.walk.bodyBobPixels',
        0,
        4,
        true,
      ),
    },
  }

  const props = propVisualTreatment(
    source.props,
    'presentation.props',
    CATALOG.props.map((prop) => prop.token),
  )
  const scenery = visualScaleTreatment(
    source.scenery,
    'presentation.scenery',
    CATALOG.scenery.map((item) => item.token),
  )

  const effectsFrames = framesFor(atlases, 'effects')
  const propEffectsSource = exactRecord(source.propEffects, 'presentation.propEffects', [
    'lantern',
    'hearth',
    'shrine',
    'pump',
    'bell',
  ])
  const propEffects = Object.fromEntries(
    Object.entries(propEffectsSource).map(([name, frameValue]) => {
      const effectSource = recordWithOptional(
        frameValue,
        `presentation.propEffects.${name}`,
        ['frames', 'frameRate'],
        ['opacityAnimation'],
      )
      const opacityAnimation =
        effectSource.opacityAnimation === undefined
          ? undefined
          : propEffectOpacityAnimation(
              effectSource.opacityAnimation,
              `presentation.propEffects.${name}.opacityAnimation`,
            )
      return [
        name,
        {
          frames: frameNames(
            effectSource.frames,
            `presentation.propEffects.${name}.frames`,
            effectsFrames,
          ),
          frameRate: positiveNumber(
            effectSource.frameRate,
            `presentation.propEffects.${name}.frameRate`,
          ),
          ...(opacityAnimation === undefined ? {} : { opacityAnimation }),
        },
      ]
    }),
  )
  const emissivesSource = exactRecord(source.emissives, 'presentation.emissives', [
    'lantern',
    'hearth',
    'frame',
  ])
  const emissives = {
    lantern: paletteKey(emissivesSource.lantern, paletteNames, 'presentation.emissives.lantern'),
    hearth: paletteKey(emissivesSource.hearth, paletteNames, 'presentation.emissives.hearth'),
    frame: knownText(emissivesSource.frame, effectsFrames, 'presentation.emissives.frame'),
  }
  const cranesSource = exactRecord(source.cranes, 'presentation.cranes', [
    'frames',
    'tint',
    'count',
    'frameMs',
  ])
  const count = array(cranesSource.count, 'presentation.cranes.count')
  if (count.length !== 2) throw new Error('presentation.cranes.count must contain two values.')
  const cranes = {
    frames: frameNames(cranesSource.frames, 'presentation.cranes.frames', effectsFrames),
    tint: paletteKey(cranesSource.tint, paletteNames, 'presentation.cranes.tint'),
    count: [
      nonnegativeInteger(count[0], 'presentation.cranes.count[0]'),
      nonnegativeInteger(count[1], 'presentation.cranes.count[1]'),
    ] as const,
    frameMs: positiveNumber(cranesSource.frameMs, 'presentation.cranes.frameMs'),
  }
  if (cranes.count[0] > cranes.count[1]) {
    throw new Error('presentation.cranes.count must be ordered from minimum to maximum.')
  }

  const expressionsSource = exactRecord(source.expressions, 'presentation.expressions', [
    'frames',
    'activityFrames',
    'tint',
    'accentFrames',
    'frameRatio',
    'worldLabel',
    'inputPalette',
  ])
  const expressionTokens = [...RULES.emotes, 'use']
  const activityTokens = [...new Set(CATALOG.props.map((prop) => prop.activity))]
  const expressionFramesSource = exactRecord(
    expressionsSource.frames,
    'presentation.expressions.frames',
    expressionTokens,
  )
  const activityFramesSource = exactRecord(
    expressionsSource.activityFrames,
    'presentation.expressions.activityFrames',
    activityTokens,
  )
  const worldLabelSource = exactRecord(
    expressionsSource.worldLabel,
    'presentation.expressions.worldLabel',
    [
      'fontSize',
      'characterWidth',
      'lineHeight',
      'paddingX',
      'paddingY',
      'iconSlotWidth',
      'iconFrameWidth',
    ],
  )
  const inputPaletteSource = exactRecord(
    expressionsSource.inputPalette,
    'presentation.expressions.inputPalette',
    [
      'plateWidth',
      'plateHeight',
      'gap',
      'contentMargin',
      'labelFontSize',
      'iconFrameWidth',
      'iconContentWidth',
      'iconStartX',
      'iconLabelGap',
    ],
  )
  const expressions = {
    frames: Object.fromEntries(
      expressionTokens.map((token) => [
        token,
        knownText(
          expressionFramesSource[token],
          effectsFrames,
          `presentation.expressions.frames.${token}`,
        ),
      ]),
    ),
    activityFrames: Object.fromEntries(
      activityTokens.map((token) => [
        token,
        knownText(
          activityFramesSource[token],
          effectsFrames,
          `presentation.expressions.activityFrames.${token}`,
        ),
      ]),
    ),
    tint: paletteKey(expressionsSource.tint, paletteNames, 'presentation.expressions.tint'),
    accentFrames: frameNames(
      expressionsSource.accentFrames,
      'presentation.expressions.accentFrames',
      effectsFrames,
    ),
    frameRatio: boundedNumber(
      expressionsSource.frameRatio,
      'presentation.expressions.frameRatio',
      0,
      1,
    ),
    worldLabel: {
      fontSize: positiveNumber(
        worldLabelSource.fontSize,
        'presentation.expressions.worldLabel.fontSize',
      ),
      characterWidth: positiveNumber(
        worldLabelSource.characterWidth,
        'presentation.expressions.worldLabel.characterWidth',
      ),
      lineHeight: positiveNumber(
        worldLabelSource.lineHeight,
        'presentation.expressions.worldLabel.lineHeight',
      ),
      paddingX: nonnegativeNumber(
        worldLabelSource.paddingX,
        'presentation.expressions.worldLabel.paddingX',
      ),
      paddingY: nonnegativeNumber(
        worldLabelSource.paddingY,
        'presentation.expressions.worldLabel.paddingY',
      ),
      iconSlotWidth: positiveNumber(
        worldLabelSource.iconSlotWidth,
        'presentation.expressions.worldLabel.iconSlotWidth',
      ),
      iconFrameWidth: positiveNumber(
        worldLabelSource.iconFrameWidth,
        'presentation.expressions.worldLabel.iconFrameWidth',
      ),
    },
    inputPalette: {
      plateWidth: positiveNumber(
        inputPaletteSource.plateWidth,
        'presentation.expressions.inputPalette.plateWidth',
      ),
      plateHeight: positiveNumber(
        inputPaletteSource.plateHeight,
        'presentation.expressions.inputPalette.plateHeight',
      ),
      gap: nonnegativeNumber(inputPaletteSource.gap, 'presentation.expressions.inputPalette.gap'),
      contentMargin: nonnegativeNumber(
        inputPaletteSource.contentMargin,
        'presentation.expressions.inputPalette.contentMargin',
      ),
      labelFontSize: positiveNumber(
        inputPaletteSource.labelFontSize,
        'presentation.expressions.inputPalette.labelFontSize',
      ),
      iconFrameWidth: positiveNumber(
        inputPaletteSource.iconFrameWidth,
        'presentation.expressions.inputPalette.iconFrameWidth',
      ),
      iconContentWidth: positiveNumber(
        inputPaletteSource.iconContentWidth,
        'presentation.expressions.inputPalette.iconContentWidth',
      ),
      iconStartX: nonnegativeNumber(
        inputPaletteSource.iconStartX,
        'presentation.expressions.inputPalette.iconStartX',
      ),
      iconLabelGap: nonnegativeNumber(
        inputPaletteSource.iconLabelGap,
        'presentation.expressions.inputPalette.iconLabelGap',
      ),
    },
  }

  return {
    atlases: source.atlases,
    thumbnail,
    palette,
    transition,
    terrain,
    roofs,
    postEffects,
    characters,
    props,
    scenery,
    propEffects,
    emissives,
    cranes,
    expressions,
  }
}

function colorGradeTreatment(
  value: unknown,
  name: string,
  palette: ReadonlySet<string>,
): ColorGradeTreatment {
  const source = exactRecord(value, name, [
    'brightness',
    'contrast',
    'saturation',
    'tint',
    'tintMix',
  ])
  return {
    brightness: boundedNumber(source.brightness, `${name}.brightness`, 0, 2),
    contrast: boundedNumber(source.contrast, `${name}.contrast`, 0, 2),
    saturation: boundedNumber(source.saturation, `${name}.saturation`, 0, 2, true),
    tint: paletteKey(source.tint, palette, `${name}.tint`),
    tintMix: unitNumber(source.tintMix, `${name}.tintMix`),
  }
}

function textureOutlineTreatment(
  value: unknown,
  name: string,
  palette: ReadonlySet<string>,
): TextureOutlineTreatment {
  const source = exactRecord(value, name, ['tint', 'layers'])
  const layerSources = array(source.layers, `${name}.layers`)
  if (layerSources.length < 2 || layerSources.length > 6) {
    throw new Error(`${name}.layers must contain between two and six layers.`)
  }
  const layers = layerSources.map((layer, index) => {
    const layerName = `${name}.layers[${index}]`
    const layerSource = exactRecord(layer, layerName, ['scaleFactor', 'opacity'])
    return {
      scaleFactor: boundedNumber(layerSource.scaleFactor, `${layerName}.scaleFactor`, 1, 1.25),
      opacity: boundedNumber(layerSource.opacity, `${layerName}.opacity`, 0, 1),
    }
  })
  for (let index = 1; index < layers.length; index += 1) {
    const previous = layers[index - 1]
    const current = layers[index]
    if (previous === undefined || current === undefined) continue
    if (current.scaleFactor >= previous.scaleFactor || current.opacity <= previous.opacity) {
      throw new Error(`${name}.layers must run from the faint outer edge to the strong inner edge.`)
    }
  }
  return {
    tint: paletteKey(source.tint, palette, `${name}.tint`),
    layers,
  }
}

function visualScaleTreatment(
  value: unknown,
  name: string,
  knownTypes: readonly string[],
): VisualScaleTreatment {
  const source = exactRecord(value, name, ['defaultScale', 'scaleByType'])
  const overrides = recordWithOptional(source.scaleByType, `${name}.scaleByType`, [], knownTypes)
  const calibrate = (scale: unknown, item: string): number =>
    boundedNumber(scale, `${name}.${item}`, 0.05, 1.0, true)
  return {
    defaultScale: calibrate(source.defaultScale, 'defaultScale'),
    scaleByType: Object.fromEntries(
      Object.entries(overrides).map(([type, scale]) => [
        type,
        calibrate(scale, `scaleByType.${type}`),
      ]),
    ),
  }
}

function propVisualTreatment(
  value: unknown,
  name: string,
  knownTypes: readonly string[],
): PropVisualTreatment {
  const source = exactRecord(value, name, [
    'defaultScale',
    'scaleByType',
    'effectAnchorByType',
    'bellStriker',
  ])
  const scales = visualScaleTreatment(
    { defaultScale: source.defaultScale, scaleByType: source.scaleByType },
    name,
    knownTypes,
  )
  const anchors = recordWithOptional(
    source.effectAnchorByType,
    `${name}.effectAnchorByType`,
    [],
    knownTypes,
  )
  return {
    ...scales,
    effectAnchorByType: Object.fromEntries(
      Object.entries(anchors).map(([type, value]) => {
        const anchor = exactRecord(value, `${name}.effectAnchorByType.${type}`, ['x', 'y'])
        return [
          type,
          {
            x: boundedNumber(anchor.x, `${name}.effectAnchorByType.${type}.x`, -192, 192),
            y: boundedNumber(anchor.y, `${name}.effectAnchorByType.${type}.y`, -128, 128),
          },
        ]
      }),
    ),
    bellStriker: readBellStrikerTreatment(source.bellStriker, `${name}.bellStriker`),
  }
}

function readBellStrikerTreatment(value: unknown, name: string): BellStrikerTreatment {
  const source = exactRecord(value, name, ['pivot', 'amplitudeRadians', 'periodTicks'])
  const pivotSource = exactRecord(source.pivot, `${name}.pivot`, ['x', 'y'])
  const x = nonnegativeInteger(pivotSource.x, `${name}.pivot.x`)
  const y = nonnegativeInteger(pivotSource.y, `${name}.pivot.y`)
  if (x >= 384 || y >= 256) {
    throw new Error(`${name}.pivot must be inside its 384 by 256 bell striker frame.`)
  }
  return {
    pivot: { x, y },
    amplitudeRadians: boundedNumber(
      source.amplitudeRadians,
      `${name}.amplitudeRadians`,
      0,
      Math.PI / 4,
    ),
    periodTicks: positiveNumber(source.periodTicks, `${name}.periodTicks`),
  }
}

function visualScaleFor(type: string, treatment: VisualScaleTreatment): number {
  return treatment.scaleByType[type] ?? treatment.defaultScale
}

function propEffectOpacityAnimation(value: unknown, name: string): PropEffectOpacityAnimation {
  const source = exactRecord(value, name, ['mode', 'min', 'max', 'periodTicks'])
  if (source.mode !== 'pingPong') throw new Error(`${name}.mode must be pingPong.`)
  const min = unitNumber(source.min, `${name}.min`)
  const max = unitNumber(source.max, `${name}.max`)
  if (min > max) throw new Error(`${name}.min must be at most ${name}.max.`)
  return {
    mode: 'pingPong',
    min,
    max,
    periodTicks: positiveNumber(source.periodTicks, `${name}.periodTicks`),
  }
}

function contourTreatment(value: unknown, name: string): TerrainContourTreatment {
  const source = exactRecord(value, name, ['profiles', 'junctionTangentCells', 'maxDeviationCells'])
  const profilesSource = exactRecord(source.profiles, `${name}.profiles`, ['land', 'water'])
  return {
    profiles: {
      land: curveProfile(profilesSource.land, `${name}.profiles.land`),
      water: curveProfile(profilesSource.water, `${name}.profiles.water`),
    },
    junctionTangentCells: boundedNumber(
      source.junctionTangentCells,
      `${name}.junctionTangentCells`,
      0,
      0.5,
      true,
    ),
    maxDeviationCells: boundedNumber(
      source.maxDeviationCells,
      `${name}.maxDeviationCells`,
      0,
      0.75,
    ),
  }
}

function seamTreatment(
  value: unknown,
  name: string,
  palette: ReadonlySet<string>,
): TerrainSeamTreatment {
  const source = exactRecord(value, name, ['pooling', 'ink', 'waterHatch'])
  const poolingSource = exactRecord(source.pooling, `${name}.pooling`, [
    'widthCells',
    'darken',
    'opacity',
  ])
  const inkSource = exactRecord(source.ink, `${name}.ink`, [
    'tint',
    'widthCells',
    'opacity',
    'runLengthCells',
    'gapLengthCells',
  ])
  const hatchSource = exactRecord(source.waterHatch, `${name}.waterHatch`, [
    'tint',
    'widthCells',
    'offsetsCells',
    'opacity',
  ])
  const offsetSources = array(hatchSource.offsetsCells, `${name}.waterHatch.offsetsCells`)
  if (offsetSources.length === 0 || offsetSources.length > 4) {
    throw new Error(`${name}.waterHatch.offsetsCells must contain between one and four offsets.`)
  }
  return {
    pooling: {
      widthCells: boundedNumber(poolingSource.widthCells, `${name}.pooling.widthCells`, 0, 2),
      darken: unitNumber(poolingSource.darken, `${name}.pooling.darken`),
      opacity: unitNumber(poolingSource.opacity, `${name}.pooling.opacity`),
    },
    ink: {
      tint: paletteKey(inkSource.tint, palette, `${name}.ink.tint`),
      widthCells: boundedNumber(inkSource.widthCells, `${name}.ink.widthCells`, 0, 1),
      opacity: unitNumber(inkSource.opacity, `${name}.ink.opacity`),
      runLengthCells: orderedNumberPair(
        inkSource.runLengthCells,
        `${name}.ink.runLengthCells`,
        0,
        16,
      ),
      gapLengthCells: orderedNumberPair(
        inkSource.gapLengthCells,
        `${name}.ink.gapLengthCells`,
        0,
        4,
      ),
    },
    waterHatch: {
      tint: paletteKey(hatchSource.tint, palette, `${name}.waterHatch.tint`),
      widthCells: boundedNumber(hatchSource.widthCells, `${name}.waterHatch.widthCells`, 0, 1),
      offsetsCells: offsetSources.map((offset, index) =>
        boundedNumber(offset, `${name}.waterHatch.offsetsCells[${index}]`, 0, 4),
      ),
      opacity: unitNumber(hatchSource.opacity, `${name}.waterHatch.opacity`),
    },
  }
}

function reedMarksTreatment(
  value: unknown,
  name: string,
  palette: ReadonlySet<string>,
): TerrainReedMarksTreatment {
  const source = exactRecord(value, name, [
    'tint',
    'widthCells',
    'lengthCells',
    'perCell',
    'opacity',
  ])
  const perCell = nonnegativeInteger(source.perCell, `${name}.perCell`)
  if (perCell > 8) throw new Error(`${name}.perCell must be at most eight.`)
  return {
    tint: paletteKey(source.tint, palette, `${name}.tint`),
    widthCells: boundedNumber(source.widthCells, `${name}.widthCells`, 0, 0.5),
    lengthCells: orderedNumberPair(source.lengthCells, `${name}.lengthCells`, 0, 2),
    perCell,
    opacity: unitNumber(source.opacity, `${name}.opacity`),
  }
}

/** Resolve one fill's baked hex tint, including its optional shade toward a second color. */
export function fillTintHex(treatment: TerrainFillTreatment): string {
  const base = HEARTHSIDE_STYLE.palette[treatment.tint]
  if (treatment.tintMix === undefined) return base
  return mixedTint(base, HEARTHSIDE_STYLE.palette[treatment.tintMix.tint], treatment.tintMix.amount)
}

function routeTreatment(value: unknown, name: string): TerrainRouteTreatment {
  const source = exactRecord(value, name, ['road', 'path'])
  const roadSource = exactRecord(source.road, `${name}.road`, [
    'curve',
    'targetWidthCells',
    'minimumWidthCells',
    'edgeFadeCells',
    'opacity',
  ])
  const pathSource = exactRecord(source.path, `${name}.path`, [
    'curve',
    'widthCells',
    'edgeFadeCells',
    'opacity',
  ])
  const roadTargetWidthCells = boundedNumber(
    roadSource.targetWidthCells,
    `${name}.road.targetWidthCells`,
    0,
    8,
  )
  return {
    road: {
      curve: curveProfile(roadSource.curve, `${name}.road.curve`),
      targetWidthCells: roadTargetWidthCells,
      minimumWidthCells: boundedNumber(
        roadSource.minimumWidthCells,
        `${name}.road.minimumWidthCells`,
        0,
        roadTargetWidthCells,
      ),
      edgeFadeCells: boundedNumber(roadSource.edgeFadeCells, `${name}.road.edgeFadeCells`, 0, 0.5),
      opacity: unitNumber(roadSource.opacity, `${name}.road.opacity`),
    },
    path: {
      curve: curveProfile(pathSource.curve, `${name}.path.curve`),
      widthCells: boundedNumber(pathSource.widthCells, `${name}.path.widthCells`, 0, 2),
      edgeFadeCells: boundedNumber(pathSource.edgeFadeCells, `${name}.path.edgeFadeCells`, 0, 0.5),
      opacity: unitNumber(pathSource.opacity, `${name}.path.opacity`),
    },
  }
}

function curveProfile(value: unknown, name: string): TerrainCurveProfile {
  const source = exactRecord(value, name, ['sampleSpacingCells', 'cornerRadiusCells', 'octaves'])
  const octaveSources = array(source.octaves, `${name}.octaves`)
  if (octaveSources.length > 8) {
    throw new Error(`${name}.octaves must contain at most eight bands.`)
  }
  const octaves = octaveSources.map((octave, index) => {
    const octaveName = `${name}.octaves[${index}]`
    const octaveSource = exactRecord(octave, octaveName, ['wavelengthCells', 'amplitudeCells'])
    return {
      wavelengthCells: boundedNumber(
        octaveSource.wavelengthCells,
        `${octaveName}.wavelengthCells`,
        0,
        256,
      ),
      amplitudeCells: boundedNumber(
        octaveSource.amplitudeCells,
        `${octaveName}.amplitudeCells`,
        0,
        4,
        true,
      ),
    }
  })
  const profile: TerrainCurveProfile = {
    sampleSpacingCells: boundedNumber(
      source.sampleSpacingCells,
      `${name}.sampleSpacingCells`,
      0,
      4,
    ),
    cornerRadiusCells: boundedNumber(
      source.cornerRadiusCells,
      `${name}.cornerRadiusCells`,
      0,
      4,
      true,
    ),
    octaves,
  }
  smoothingPassesFor(profile, `${name}.cornerRadiusCells`)
  return profile
}

function plankTreatment(
  value: unknown,
  name: string,
  knownFrames: ReadonlySet<string>,
  palette: ReadonlySet<string>,
): PlankTreatment {
  const source = exactRecord(value, name, [
    'frame',
    'boardsPerCell',
    'widthVariation',
    'portalOverlapCells',
    'portalMaskInsetCells',
    'sideOverhangCells',
    'sourceOverscanCells',
    'sourcePhaseCells',
    'seam',
    'edgeShadow',
  ])
  const boardsPerCell = positiveInteger(source.boardsPerCell, `${name}.boardsPerCell`)
  if (boardsPerCell > 8) {
    throw new Error(`${name}.boardsPerCell must be at most eight.`)
  }
  const seamSource = exactRecord(source.seam, `${name}.seam`, ['tint', 'opacity', 'widthCells'])
  const edgeShadowSource = exactRecord(source.edgeShadow, `${name}.edgeShadow`, [
    'tint',
    'opacity',
    'widthCells',
  ])
  return {
    frame: knownText(source.frame, knownFrames, `${name}.frame`),
    boardsPerCell,
    widthVariation: boundedNumber(source.widthVariation, `${name}.widthVariation`, 0, 0.5, true),
    portalOverlapCells: boundedNumber(
      source.portalOverlapCells,
      `${name}.portalOverlapCells`,
      0,
      0.5,
      true,
    ),
    portalMaskInsetCells: boundedNumber(
      source.portalMaskInsetCells,
      `${name}.portalMaskInsetCells`,
      0,
      0.5,
      true,
    ),
    sideOverhangCells: boundedNumber(
      source.sideOverhangCells,
      `${name}.sideOverhangCells`,
      0,
      0.1,
      true,
    ),
    sourceOverscanCells: boundedNumber(
      source.sourceOverscanCells,
      `${name}.sourceOverscanCells`,
      0,
      0.15,
    ),
    sourcePhaseCells: boundedNumber(
      source.sourcePhaseCells,
      `${name}.sourcePhaseCells`,
      0,
      finiteNumber(source.sourceOverscanCells, `${name}.sourceOverscanCells`) / 2,
      true,
    ),
    seam: {
      tint: paletteKey(seamSource.tint, palette, `${name}.seam.tint`),
      opacity: unitNumber(seamSource.opacity, `${name}.seam.opacity`),
      widthCells: boundedNumber(seamSource.widthCells, `${name}.seam.widthCells`, 0, 0.05),
    },
    edgeShadow: {
      tint: paletteKey(edgeShadowSource.tint, palette, `${name}.edgeShadow.tint`),
      opacity: unitNumber(edgeShadowSource.opacity, `${name}.edgeShadow.opacity`),
      widthCells: boundedNumber(
        edgeShadowSource.widthCells,
        `${name}.edgeShadow.widthCells`,
        0,
        0.15,
      ),
    },
  }
}
function framesFor(
  catalog: readonly ThreeBranchesAtlasDraft[],
  group: string,
  layer?: string,
): ReadonlySet<string> {
  const atlas = catalog.find((item) => item.name === group)
  if (atlas === undefined) throw new Error(`Three Branches manifest has no ${group} atlas.`)
  if ('layers' in atlas) {
    const raster = atlas.layers.find((item) => item.name === layer)
    if (raster === undefined) {
      throw new Error(`Three Branches manifest has no ${group}.${layer} layer.`)
    }
    return new Set(raster.frames.names)
  }
  if (layer !== undefined) throw new Error(`Three Branches manifest atlas ${group} has no layers.`)
  return new Set(atlas.frames.names)
}

function frameTreatment(
  value: unknown,
  name: string,
  knownFrames: ReadonlySet<string>,
  palette: ReadonlySet<string>,
): FrameTreatment {
  const source = exactRecord(value, name, ['frames', 'tint'])
  return {
    frames: frameNames(source.frames, `${name}.frames`, knownFrames),
    tint: paletteKey(source.tint, palette, `${name}.tint`),
  }
}

function characterCastSet(
  value: unknown,
  name: string,
  knownFrames: ReadonlySet<string>,
  palette: ReadonlySet<string>,
): CharacterCastSet {
  const source = exactRecord(value, name, ['id', 'base', 'leftArm', 'rightArm', 'farMarkTint'])
  if (typeof source.id !== 'string' || source.id.length === 0) {
    throw new Error(`${name}.id must be a non-empty string.`)
  }
  return {
    id: source.id,
    base: knownText(source.base, knownFrames, `${name}.base`),
    leftArm: characterArmTreatment(source.leftArm, `${name}.leftArm`, knownFrames),
    rightArm: characterArmTreatment(source.rightArm, `${name}.rightArm`, knownFrames),
    farMarkTint: paletteKey(source.farMarkTint, palette, `${name}.farMarkTint`),
  }
}

function characterArmTreatment(
  value: unknown,
  name: string,
  knownFrames: ReadonlySet<string>,
): CharacterArmTreatment {
  const source = exactRecord(value, name, ['frame', 'pivot', 'anchor'])
  return {
    frame: knownText(source.frame, knownFrames, `${name}.frame`),
    pivot: characterPixelAnchor(source.pivot, `${name}.pivot`),
    anchor: characterPixelAnchor(source.anchor, `${name}.anchor`),
  }
}

function characterPixelAnchor(value: unknown, name: string): SourcePixelAnchor {
  const source = exactRecord(value, name, ['x', 'y'])
  const x = nonnegativeInteger(source.x, `${name}.x`)
  const y = nonnegativeInteger(source.y, `${name}.y`)
  if (x >= 192 || y >= 192) {
    throw new Error(`${name} must be inside its 192 by 192 character frame.`)
  }
  return { x, y }
}

function terrainFillTreatment(
  value: unknown,
  name: string,
  knownFrames: ReadonlySet<string>,
  palette: ReadonlySet<string>,
): TerrainFillTreatment {
  const source = recordWithOptional(
    value,
    name,
    ['frames', 'tint', 'opacity'],
    ['offsetPassOpacity', 'detailShift', 'tintMix'],
  )
  const treatment: TerrainFillTreatment = {
    frames: frameNames(source.frames, `${name}.frames`, knownFrames),
    tint: paletteKey(source.tint, palette, `${name}.tint`),
    opacity: unitNumber(source.opacity, `${name}.opacity`),
    offsetPassOpacity:
      source.offsetPassOpacity === undefined
        ? 0.5
        : unitNumber(source.offsetPassOpacity, `${name}.offsetPassOpacity`),
  }
  if (source.detailShift !== undefined) {
    treatment.detailShift = boundedNumber(source.detailShift, `${name}.detailShift`, 0, 0.5)
  }
  if (source.tintMix !== undefined) {
    const mixSource = exactRecord(source.tintMix, `${name}.tintMix`, ['tint', 'amount'])
    treatment.tintMix = {
      tint: paletteKey(mixSource.tint, palette, `${name}.tintMix.tint`),
      amount: unitNumber(mixSource.amount, `${name}.tintMix.amount`),
    }
  }
  return treatment
}

function recordWithOptional(
  value: unknown,
  name: string,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`)
  }
  const result = value as Record<string, unknown>
  const allowed = new Set([...requiredKeys, ...optionalKeys])
  if (
    requiredKeys.some((key) => !(key in result)) ||
    Object.keys(result).some((key) => !allowed.has(key))
  ) {
    throw new Error(`${name} keys do not match its contract.`)
  }
  return result
}

function frameNames(value: unknown, name: string, known: ReadonlySet<string>): readonly string[] {
  const result = array(value, name).map((item, index) =>
    knownText(item, known, `${name}[${index}]`),
  )
  if (result.length === 0) throw new Error(`${name} must contain at least one frame.`)
  return result
}

function exactRecord(
  value: unknown,
  name: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`)
  }
  const result = value as Record<string, unknown>
  const expected = new Set(keys)
  if (
    keys.some((key) => !(key in result)) ||
    Object.keys(result).some((key) => !expected.has(key))
  ) {
    throw new Error(`${name} keys do not match its contract.`)
  }
  return result
}

function knownText(value: unknown, known: ReadonlySet<string>, name: string): string {
  if (typeof value !== 'string' || !known.has(value)) throw new Error(`${name} is unknown.`)
  return value
}

function paletteKey(
  value: unknown,
  known: ReadonlySet<string>,
  name: string,
): HearthsidePaletteKey {
  return knownText(value, known, name) as HearthsidePaletteKey
}

function hex(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/.test(value)) {
    throw new Error(`${name} must be a lowercase six-digit hex color.`)
  }
  return value
}

function nonnegativeNumber(value: unknown, name: string): number {
  const result = finiteNumber(value, name)
  if (result < 0) throw new Error(`${name} must be non-negative.`)
  return result
}

function unitNumber(value: unknown, name: string): number {
  const result = nonnegativeNumber(value, name)
  if (result > 1) throw new Error(`${name} must be at most one.`)
  return result
}

function orderedNumberPair(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  allowsMinimum = false,
): readonly [number, number] {
  const source = array(value, name)
  if (source.length !== 2) {
    throw new Error(`${name} must contain a minimum and maximum.`)
  }
  const result = [
    boundedNumber(source[0], `${name}[0]`, minimum, maximum, allowsMinimum),
    boundedNumber(source[1], `${name}[1]`, minimum, maximum, allowsMinimum),
  ] as const
  if (result[0] > result[1]) {
    throw new Error(`${name} must be ordered minimum to maximum.`)
  }
  return result
}

function boundedNumber(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  allowsMinimum = false,
): number {
  const result = finiteNumber(value, name)
  if ((allowsMinimum ? result < minimum : result <= minimum) || result > maximum) {
    throw new Error(
      allowsMinimum
        ? `${name} must be between ${minimum} and ${maximum}.`
        : `${name} must be greater than ${minimum} and at most ${maximum}.`,
    )
  }
  return result
}
