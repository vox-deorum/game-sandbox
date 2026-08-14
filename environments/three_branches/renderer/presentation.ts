import { type RenderOptions, transitionScaleOf } from '@renderers/types.js'

import { THREE_BRANCHES_ASSET_CATALOG } from './assets.js'
import { RULES } from './overlay.js'
import presentationDocument from './presentation.json'
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
  /** Height of the fixed diagnostic strip. */
  chromeHeight: number
  /** Renderer world units used for one configured metre. */
  unitsPerMetre: number
  /** World-space padding used to derive camera limits. */
  cameraPadding: number
  /** Maximum zoom expressed as a multiple of fitted zoom. */
  maxZoomFactor: number
  /** Visitor-focused opening zoom expressed as a multiple of fitted zoom. */
  focusZoomFactor: number
}

/** Fixed renderer mechanics that are not Hearthside Ink art calibration. */
export const THREE_BRANCHES_PRESENTATION: ThreeBranchesPresentation = {
  internalSize: { width: 1200, height: 1000 },
  chromeHeight: 54,
  unitsPerMetre: 16,
  cameraPadding: 20,
  maxZoomFactor: 4,
  focusZoomFactor: 2,
} as const

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

export const EDGE_CORNER_DIRECTIONS = ['northEast', 'southEast', 'southWest', 'northWest'] as const
export type EdgeCornerDirection = (typeof EDGE_CORNER_DIRECTIONS)[number]
/** The water-bank frame order indexed directly by the planner's four-bit cardinal mask. */
export const WATER_BANK_CARDINAL_FRAMES = [
  'edge00',
  'edge01',
  'edge02',
  'edge03',
  'edge04',
  'edge05',
  'edge06',
  'edge07',
  'edge08',
  'edge09',
  'edge10',
  'edge11',
  'edge12',
  'edge13',
  'edge14',
  'edge15',
] as const

/** A class boundary that needs only its cardinal frame family. */
export interface CardinalEdgeTreatment extends FrameTreatment {
  from: string
  to: string
  corners?: never
  accents?: never
}

/** The configured water bank, which owns its corner and accent families. */
export interface WaterBankEdgeTreatment extends FrameTreatment {
  from: 'water'
  to: 'ground'
  corners: Readonly<Record<EdgeCornerDirection, readonly string[]>>
  accents: readonly string[]
}

/** Only water-to-ground may configure corners and bank accents. */
export type EdgeTreatment = CardinalEdgeTreatment | WaterBankEdgeTreatment

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
    fills: Readonly<Record<string, FrameTreatment>>
    edges: {
      layers: number
      pairings: readonly EdgeTreatment[]
    }
    planks: FrameTreatment
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
    walk: { frames: readonly string[]; frameMs: number }
    visitor: { detail: string; tint: HearthsidePaletteKey }
  }
  propEffects: Readonly<Record<string, readonly string[]>>
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
    'edges',
    'planks',
    'upperWall',
  ])
  const groundNames = RULES.grounds.map((ground) => ground.name)
  const fillsSource = exactRecord(terrainSource.fills, 'presentation.terrain.fills', groundNames)
  const fills = Object.fromEntries(
    groundNames.map((name) => [
      name,
      frameTreatment(
        fillsSource[name],
        `presentation.terrain.fills.${name}`,
        terrainFrames,
        paletteNames,
      ),
    ]),
  )
  const edgesSource = exactRecord(terrainSource.edges, 'presentation.terrain.edges', [
    'layers',
    'pairings',
  ])
  const knownGround = new Set(groundNames)
  const pairings = array(edgesSource.pairings, 'presentation.terrain.edges.pairings').map(
    (item, index) => edgeTreatment(item, index, knownGround, terrainFrames, paletteNames),
  )
  const terrain = {
    fills,
    edges: {
      layers: positiveInteger(edgesSource.layers, 'presentation.terrain.edges.layers'),
      pairings,
    },
    planks: frameTreatment(
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
    'frameMs',
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
      frameMs: positiveNumber(walkSource.frameMs, 'presentation.characters.walk.frameMs'),
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
    Object.entries(propEffectsSource).map(([name, frameValue]) => [
      name,
      frameNames(frameValue, `presentation.propEffects.${name}`, effectsFrames),
    ]),
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

function edgeTreatment(
  value: unknown,
  index: number,
  knownGround: ReadonlySet<string>,
  knownFrames: ReadonlySet<string>,
  palette: ReadonlySet<string>,
): EdgeTreatment {
  const name = `presentation.terrain.edges.pairings[${index}]`
  const raw = record(value, name)
  const from = knownText(raw.from, knownGround, `${name}.from`)
  const to = knownText(raw.to, knownGround, `${name}.to`)
  const waterBank = from === 'water' && to === 'ground'
  const pairing = exactRecord(
    raw,
    name,
    waterBank ? ['from', 'to', 'frames', 'tint', 'corners', 'accents'] : ['from', 'to', 'frames', 'tint'],
  )
  const corners = waterBank ? cornerFrames(pairing.corners, `${name}.corners`, knownFrames) : undefined
  const accents = waterBank
    ? frameNames(pairing.accents, `${name}.accents`, knownFrames)
    : undefined
  const treatment = waterBank
    ? {
        frames: waterBankCardinalFrames(pairing.frames, `${name}.frames`, knownFrames),
        tint: paletteKey(pairing.tint, palette, `${name}.tint`),
      }
    : frameTreatment({ frames: pairing.frames, tint: pairing.tint }, name, knownFrames, palette)
  if (waterBank) {
    return { from: 'water', to: 'ground', ...treatment, corners: corners!, accents: accents! }
  }
  return { from, to, ...treatment }
}
function waterBankCardinalFrames(
  value: unknown,
  name: string,
  known: ReadonlySet<string>,
): readonly string[] {
  const frames = frameNames(value, name, known)
  if (
    frames.length !== WATER_BANK_CARDINAL_FRAMES.length ||
    frames.some((frame, index) => frame !== WATER_BANK_CARDINAL_FRAMES[index])
  ) {
    throw new Error(`${name} must equal the water-bank cardinal order edge00 through edge15.`)
  }
  return frames
}
function cornerFrames(
  value: unknown,
  name: string,
  known: ReadonlySet<string>,
): Record<EdgeCornerDirection, readonly string[]> {
  const source = exactRecord(value, name, EDGE_CORNER_DIRECTIONS)
  return Object.fromEntries(
    EDGE_CORNER_DIRECTIONS.map((direction) => [
      direction,
      twoFrameNames(source[direction], `${name}.${direction}`, known),
    ]),
  ) as Record<EdgeCornerDirection, readonly string[]>
}
function twoFrameNames(value: unknown, name: string, known: ReadonlySet<string>): readonly string[] {
  const frames = frameNames(value, name, known)
  if (frames.length !== 2) throw new Error(`${name} must contain exactly two frames.`)
  return frames
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

function frameNames(value: unknown, name: string, known: ReadonlySet<string>): readonly string[] {
  const result = array(value, name).map((item, index) =>
    knownText(item, known, `${name}[${index}]`),
  )
  if (result.length === 0) throw new Error(`${name} must contain at least one frame.`)
  return result
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`)
  }
  return value as Record<string, unknown>
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
