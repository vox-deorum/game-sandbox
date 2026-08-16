import { type RenderOptions, transitionScaleOf } from '@renderers/types.js'

import { THREE_BRANCHES_ASSET_CATALOG } from './assets.js'
import { RULES } from './overlay.js'
import presentationDocument from './presentation.json'
import { smoothingPassesFor } from './terrain-curves.js'
import { mixedTint } from './tint.js'
import type { TerrainCurveProfile } from './types.js'
import { array, finiteNumber, nonnegativeInteger, positiveNumber } from './validation.js'

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
  focusZoomFactor: 2,
  nameplateZoomFactor: 1.5,
  nameplateFadeFactor: 0.5,
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
  /** Fixed chrome surface. */
  chrome: string
  /** Primary label color. */
  text: string
  /** Secondary label and border color. */
  muted: string
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
  chrome: '#202b29',
  text: '#f5f3ea',
  muted: '#b8c7c4',
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
  minimumCorridorCells: number
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
    bridgeTaperCells: number
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
  horizontal: string
  vertical: string
  compact: string
  tint: HearthsidePaletteKey
  shadowTint: HearthsidePaletteKey
  shadowOpacity: number
  shadowOffsetCells: number
}

export interface PhaseGrade {
  brightness: number
  contrast: number
  saturation: number
  tint: HearthsidePaletteKey
}

/** Validated art and motion calibration owned by presentation.json. */
export interface HearthsideStyle {
  palette: HearthsidePalette
  transition: { naturalMs: number; settleGraceMs: number }
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
    frames: Readonly<Record<string, readonly string[]>>
  }
  phaseGrades: Readonly<Record<string, PhaseGrade>>
  characters: {
    clothingTints: readonly HearthsidePaletteKey[]
    details: readonly string[]
    walk: { frames: readonly string[]; frameRatio: number }
    visitor: { detail: string; tint: HearthsidePaletteKey }
  }
  propEffects: Readonly<Record<string, { frames: readonly string[]; frameRate: number }>>
  emissives: { lantern: HearthsidePaletteKey; hearth: HearthsidePaletteKey; frame: string }
  cranes: {
    frames: readonly string[]
    tint: HearthsidePaletteKey
    count: readonly [number, number]
    frameMs: number
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
  deliveryGapMs?: number,
  style: Pick<HearthsideStyle, 'transition'> = HEARTHSIDE_STYLE,
): number {
  if (options?.snap === true) return 0
  if (options?.transitionScale !== undefined) {
    return style.transition.naturalMs * transitionScaleOf(options)
  }
  return deliveryGapMs !== undefined && Number.isFinite(deliveryGapMs) && deliveryGapMs >= 0
    ? Math.min(deliveryGapMs, style.transition.naturalMs)
    : style.transition.naturalMs
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

/** Day and unknown phases are deliberately neutral. */
export function phaseGrade(phase: string): PhaseGrade | null {
  return HEARTHSIDE_STYLE.phaseGrades[phase] ?? null
}

/** Validate an injected document for tests and future configuration edits. */
export function readHearthsideStyle(value: unknown): HearthsideStyle {
  const source = exactRecord(value, 'presentation', [
    'palette',
    'transition',
    'terrain',
    'roofs',
    'phaseGrades',
    'characters',
    'propEffects',
    'emissives',
    'cranes',
  ])
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
  ])
  const transition = {
    naturalMs: positiveNumber(transitionSource.naturalMs, 'presentation.transition.naturalMs'),
    settleGraceMs: nonnegativeNumber(
      transitionSource.settleGraceMs,
      'presentation.transition.settleGraceMs',
    ),
  }

  const terrainFrames = framesFor('terrain')
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
  const terrain = {
    fills,
    contours: contourTreatment(terrainSource.contours, 'presentation.terrain.contours'),
    seams: seamTreatment(terrainSource.seams, 'presentation.terrain.seams', paletteNames),
    reedMarks: reedMarksTreatment(
      terrainSource.reedMarks,
      'presentation.terrain.reedMarks',
      paletteNames,
    ),
    routes: routeTreatment(terrainSource.routes, 'presentation.terrain.routes'),
    planks: plankTreatment(
      terrainSource.planks,
      'presentation.terrain.planks',
      terrainFrames,
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
  const roofFramesSource = exactRecord(roofsSource.frames, 'presentation.roofs.frames', [
    'home',
    'inn',
    'shed',
  ])
  const buildingFrames = framesFor('buildings')
  const roofs = {
    clearAlpha: unitNumber(roofsSource.clearAlpha, 'presentation.roofs.clearAlpha'),
    fadeMs: positiveNumber(roofsSource.fadeMs, 'presentation.roofs.fadeMs'),
    frames: Object.fromEntries(
      Object.entries(roofFramesSource).map(([name, frameValue]) => [
        name,
        frameNames(frameValue, `presentation.roofs.frames.${name}`, buildingFrames),
      ]),
    ),
  }

  const configuredPhases = RULES.phases.map((phase) => phase.name)
  const gradesSource = exactRecord(source.phaseGrades, 'presentation.phaseGrades', configuredPhases)
  const phaseGrades = Object.fromEntries(
    configuredPhases.map((name) => {
      const path = `presentation.phaseGrades.${name}`
      const grade = exactRecord(gradesSource[name], path, [
        'brightness',
        'contrast',
        'saturation',
        'tint',
      ])
      return [
        name,
        {
          brightness: positiveNumber(grade.brightness, `${path}.brightness`),
          contrast: positiveNumber(grade.contrast, `${path}.contrast`),
          saturation: nonnegativeNumber(grade.saturation, `${path}.saturation`),
          tint: paletteKey(grade.tint, paletteNames, `${path}.tint`),
        },
      ]
    }),
  )

  const charactersSource = exactRecord(source.characters, 'presentation.characters', [
    'clothingTints',
    'details',
    'walk',
    'visitor',
  ])
  const detailFrames = framesFor('characters', 'details')
  const poseFrames = framesFor('characters', 'body')
  const walkSource = exactRecord(charactersSource.walk, 'presentation.characters.walk', [
    'frames',
    'frameRatio',
  ])
  const visitorSource = exactRecord(charactersSource.visitor, 'presentation.characters.visitor', [
    'detail',
    'tint',
  ])
  const characters = {
    clothingTints: array(
      charactersSource.clothingTints,
      'presentation.characters.clothingTints',
    ).map((item, index) =>
      paletteKey(item, paletteNames, `presentation.characters.clothingTints[${index}]`),
    ),
    details: frameNames(charactersSource.details, 'presentation.characters.details', detailFrames),
    walk: {
      frames: frameNames(walkSource.frames, 'presentation.characters.walk.frames', poseFrames),
      frameRatio: boundedNumber(
        walkSource.frameRatio,
        'presentation.characters.walk.frameRatio',
        0,
        1,
      ),
    },
    visitor: {
      detail: knownText(
        visitorSource.detail,
        detailFrames,
        'presentation.characters.visitor.detail',
      ),
      tint: paletteKey(visitorSource.tint, paletteNames, 'presentation.characters.visitor.tint'),
    },
  }

  const effectsFrames = framesFor('effects')
  const propEffectsSource = exactRecord(source.propEffects, 'presentation.propEffects', [
    'lantern',
    'hearth',
    'shrine',
    'pump',
    'bell',
  ])
  const propEffects = Object.fromEntries(
    Object.entries(propEffectsSource).map(([name, frameValue]) => {
      const effectSource = exactRecord(frameValue, `presentation.propEffects.${name}`, [
        'frames',
        'frameRate',
      ])
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

  return {
    palette,
    transition,
    terrain,
    roofs,
    phaseGrades,
    characters,
    propEffects,
    emissives,
    cranes,
  }
}

function contourTreatment(value: unknown, name: string): TerrainContourTreatment {
  const source = exactRecord(value, name, [
    'profiles',
    'junctionTangentCells',
    'maxDeviationCells',
    'minimumCorridorCells',
  ])
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
    minimumCorridorCells: boundedNumber(
      source.minimumCorridorCells,
      `${name}.minimumCorridorCells`,
      0.25,
      1,
      true,
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
    'bridgeTaperCells',
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
      bridgeTaperCells: boundedNumber(
        hatchSource.bridgeTaperCells,
        `${name}.waterHatch.bridgeTaperCells`,
        0,
        1,
        true,
      ),
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
      edgeFadeCells: boundedNumber(
        roadSource.edgeFadeCells,
        `${name}.road.edgeFadeCells`,
        0,
        0.5,
      ),
      opacity: unitNumber(roadSource.opacity, `${name}.road.opacity`),
    },
    path: {
      curve: curveProfile(pathSource.curve, `${name}.path.curve`),
      widthCells: boundedNumber(pathSource.widthCells, `${name}.path.widthCells`, 0, 2),
      edgeFadeCells: boundedNumber(
        pathSource.edgeFadeCells,
        `${name}.path.edgeFadeCells`,
        0,
        0.5,
      ),
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
    'horizontal',
    'vertical',
    'compact',
    'tint',
    'shadowTint',
    'shadowOpacity',
    'shadowOffsetCells',
  ])
  return {
    horizontal: knownText(source.horizontal, knownFrames, `${name}.horizontal`),
    vertical: knownText(source.vertical, knownFrames, `${name}.vertical`),
    compact: knownText(source.compact, knownFrames, `${name}.compact`),
    tint: paletteKey(source.tint, palette, `${name}.tint`),
    shadowTint: paletteKey(source.shadowTint, palette, `${name}.shadowTint`),
    shadowOpacity: unitNumber(source.shadowOpacity, `${name}.shadowOpacity`),
    shadowOffsetCells: boundedNumber(
      source.shadowOffsetCells,
      `${name}.shadowOffsetCells`,
      0,
      1,
    ),
  }
}
function framesFor(group: string, layer?: string): ReadonlySet<string> {
  const atlas = THREE_BRANCHES_ASSET_CATALOG.find((item) => item.name === group)
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
