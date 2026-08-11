/** Validated visual tuning for Hearthside Ink, kept separate from village generation. */
import { stableHash } from '@renderers/base/math.js'

import propsData from '../props.json'
import { THREE_BRANCHES_ASSET_MANIFEST, type ThreeBranchesAssetName } from './assets.js'
import rawPresentation from './presentation.json'

export const HEARTHSIDE_STYLE_KEYS = [
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

export type HearthsideColorName = (typeof HEARTHSIDE_STYLE_KEYS)[number]
export type HearthsideStyle = Record<HearthsideColorName, string>
export type PresentationLevel = 'compact' | 'simple' | 'detailed'
export type HandsFrame = 'rest' | 'leftForward' | 'pass' | 'rightForward'
export type DayPhase = 'day' | 'dawn' | 'morning' | 'midday' | 'evening' | 'night'

interface ActiveEffectConfig {
  state: string
  asset: ThreeBranchesAssetName
  postGrade: boolean
  periodTicks: number
}

export interface PresentationConfig {
  version: number
  worldScale: number
  palette: HearthsideStyle
  ground: {
    variantCount: number
    washStride: number
    markCells: number
    colors: Record<string, HearthsideColorName>
    marks: Record<string, ThreeBranchesAssetName[]>
  }
  surfaces: {
    widenMeters: number
    edgeBandMeters: number
    tileMeters: number
  }
  characters: {
    simpleCssWidth: number
    detailedCssWidth: number
    spriteMeters: number
    walkFrameTicks: number
  }
  timing: { tickTransitionMs: number }
  phaseGrades: Record<DayPhase, { color: string; alpha: number }>
  props: {
    stateAssets: Record<string, Record<string, ThreeBranchesAssetName>>
    activeEffects: Record<string, ActiveEffectConfig>
    emissiveStates: Record<string, { state: string; asset: ThreeBranchesAssetName }>
  }
  cranes: {
    count: number
    periodTicks: number
    spriteWidthMeters: number
    spriteHeightMeters: number
    marginMeters: number
  }
}

const PHASES: readonly DayPhase[] = ['day', 'dawn', 'morning', 'midday', 'evening', 'night']
const ASSET_NAME = /^[a-z][A-Za-z0-9]*$/
const ASSET_NAMES = new Set<string>(THREE_BRANCHES_ASSET_MANIFEST.map((asset) => asset.name))
const HEX_COLOR = /^#[0-9a-f]{6}$/

/** Validate the checked-in presentation file without silently accepting partial tuning. */
export function validatePresentation(value: unknown): PresentationConfig {
  const root = object(value, 'presentation must be an object')
  exactKeys(root, [
    'version',
    'worldScale',
    'palette',
    'ground',
    'surfaces',
    'characters',
    'timing',
    'phaseGrades',
    'props',
    'cranes',
  ])
  if (root.version !== 1) throw new Error('presentation version must be 1')
  positive(root.worldScale, 'presentation worldScale')
  const palette = object(root.palette, 'presentation palette must be an object')
  exactKeys(palette, HEARTHSIDE_STYLE_KEYS)
  for (const key of HEARTHSIDE_STYLE_KEYS) color(palette[key], `palette ${key}`)

  const ground = object(root.ground, 'presentation ground must be an object')
  exactKeys(ground, ['variantCount', 'washStride', 'markCells', 'colors', 'marks'])
  positiveInteger(ground.variantCount, 'ground variantCount')
  positiveInteger(ground.washStride, 'ground washStride')
  positiveInteger(ground.markCells, 'ground markCells')
  const groundColors = stringRecord(ground.colors, 'ground colors')
  const groundMarks = arrayRecord(ground.marks, 'ground marks')
  if (Object.keys(groundColors).sort().join('') !== 'eforw') {
    throw new Error('ground colors must configure e, f, o, r, and w')
  }
  // The water, road, footpath, and bridge codes are a one-metre sampling of geometry the vector
  // layer draws exactly, so they carry the land colour and no mark of their own.
  if (Object.keys(groundMarks).sort().join('') !== 'efo') {
    throw new Error('ground marks must configure e, f, and o')
  }
  for (const [code, name] of Object.entries(groundColors)) {
    paletteColor(name, `ground color ${code}`)
  }
  for (const [code, names] of Object.entries(groundMarks)) {
    if (names.length !== ground.variantCount) {
      throw new Error(`ground marks ${code} must match variantCount`)
    }
    for (const name of names) assetName(name, `ground mark ${code}`)
  }

  const surfaces = object(root.surfaces, 'presentation surfaces must be an object')
  exactKeys(surfaces, ['widenMeters', 'edgeBandMeters', 'tileMeters'])
  positive(surfaces.widenMeters, 'surfaces widenMeters')
  positive(surfaces.edgeBandMeters, 'surfaces edgeBandMeters')
  positive(surfaces.tileMeters, 'surfaces tileMeters')

  const characters = object(root.characters, 'presentation characters must be an object')
  exactKeys(characters, ['simpleCssWidth', 'detailedCssWidth', 'spriteMeters', 'walkFrameTicks'])
  positive(characters.simpleCssWidth, 'characters simpleCssWidth')
  positive(characters.detailedCssWidth, 'characters detailedCssWidth')
  if ((characters.simpleCssWidth as number) >= (characters.detailedCssWidth as number)) {
    throw new Error('character presentation thresholds must increase')
  }
  positive(characters.spriteMeters, 'characters spriteMeters')
  positiveInteger(characters.walkFrameTicks, 'characters walkFrameTicks')

  const timing = object(root.timing, 'presentation timing must be an object')
  exactKeys(timing, ['tickTransitionMs'])
  positive(timing.tickTransitionMs, 'timing tickTransitionMs')

  const grades = object(root.phaseGrades, 'presentation phaseGrades must be an object')
  exactKeys(grades, PHASES)
  for (const phase of PHASES) {
    const grade = object(grades[phase], `phase grade ${phase} must be an object`)
    exactKeys(grade, ['color', 'alpha'])
    color(grade.color, `phase grade ${phase} color`)
    numberBetween(grade.alpha, 0, 1, `phase grade ${phase} alpha`)
  }
  if ((object(grades.day, 'day grade').alpha as number) !== 0) {
    throw new Error('the day phase grade must be neutral')
  }

  const props = object(root.props, 'presentation props must be an object')
  exactKeys(props, ['stateAssets', 'activeEffects', 'emissiveStates'])
  const stateAssets = nestedStringRecord(props.stateAssets, 'prop stateAssets')
  for (const definition of propsData.props) {
    const states = stateAssets[definition.token]
    if (states === undefined) throw new Error(`prop ${definition.token} has no state artwork`)
    exactKeys(states, definition.states)
    for (const [state, name] of Object.entries(states))
      assetName(name, `${definition.token} ${state}`)
  }
  if (Object.keys(stateAssets).length !== propsData.props.length) {
    throw new Error('prop stateAssets contains an unknown prop')
  }
  const activeEffects = object(props.activeEffects, 'prop activeEffects must be an object')
  for (const [token, unknownEffect] of Object.entries(activeEffects)) {
    const effect = object(unknownEffect, `active effect ${token} must be an object`)
    exactKeys(effect, ['state', 'asset', 'postGrade', 'periodTicks'])
    if (typeof effect.state !== 'string')
      throw new Error(`active effect ${token} state must be text`)
    assetName(effect.asset, `active effect ${token}`)
    if (typeof effect.postGrade !== 'boolean') {
      throw new Error(`active effect ${token} postGrade must be true or false`)
    }
    positiveInteger(effect.periodTicks, `active effect ${token} periodTicks`)
    if (!(effect.state in (stateAssets[token] ?? {}))) {
      throw new Error(`active effect ${token} uses an unknown state`)
    }
  }
  const emissiveStates = object(props.emissiveStates, 'prop emissiveStates must be an object')
  for (const [token, unknownEmissive] of Object.entries(emissiveStates)) {
    const emissive = object(unknownEmissive, `emissive state ${token} must be an object`)
    exactKeys(emissive, ['state', 'asset'])
    if (typeof emissive.state !== 'string' || !(emissive.state in (stateAssets[token] ?? {}))) {
      throw new Error(`emissive state ${token} uses an unknown state`)
    }
    assetName(emissive.asset, `emissive state ${token}`)
  }

  const cranes = object(root.cranes, 'presentation cranes must be an object')
  exactKeys(cranes, [
    'count',
    'periodTicks',
    'spriteWidthMeters',
    'spriteHeightMeters',
    'marginMeters',
  ])
  positiveInteger(cranes.count, 'cranes count')
  positiveInteger(cranes.periodTicks, 'cranes periodTicks')
  positive(cranes.spriteWidthMeters, 'cranes spriteWidthMeters')
  positive(cranes.spriteHeightMeters, 'cranes spriteHeightMeters')
  positive(cranes.marginMeters, 'cranes marginMeters')

  return value as PresentationConfig
}

export const PRESENTATION = validatePresentation(rawPresentation)
export const HEARTHSIDE_STYLE: HearthsideStyle = PRESENTATION.palette

export function presentationFor(bodyCssWidth: number): PresentationLevel {
  if (bodyCssWidth < PRESENTATION.characters.simpleCssWidth) return 'compact'
  if (bodyCssWidth < PRESENTATION.characters.detailedCssWidth) return 'simple'
  return 'detailed'
}

export function variantFor(layoutKey: string, code: string, column: number, row: number): number {
  return stableHash(`${layoutKey}:${code}:${column}:${row}`) % PRESENTATION.ground.variantCount
}

export function showsGroundMark(layoutKey: string, column: number, row: number): boolean {
  return stableHash(`${layoutKey}:mark:${column}:${row}`) % PRESENTATION.ground.washStride === 0
}

export function headAssetFor(id: string): ThreeBranchesAssetName {
  if (id === 'visitor') return 'visitorHead'
  return (
    (['villagerHeadA', 'villagerHeadB', 'villagerHeadC'] as const)[stableHash(id) % 3] ??
    'villagerHeadA'
  )
}

export function handsFrameFor(tick: number, id: string, moved: number): HandsFrame {
  return handsBlendFor(tick, id, moved).current
}

export interface HandsBlend {
  current: HandsFrame
  next: HandsFrame
  mix: number
}

const HANDS_FRAMES: readonly HandsFrame[] = ['rest', 'leftForward', 'pass', 'rightForward']

/** Cross-fade adjacent authored hand poses from the deterministic fractional replay tick. */
export function handsBlendFor(tick: number, id: string, moved: number): HandsBlend {
  if (moved <= 0) return { current: 'rest', next: 'rest', mix: 0 }
  const framePosition = tick / PRESENTATION.characters.walkFrameTicks
  const whole = Math.floor(framePosition)
  const offset = stableHash(id) % HANDS_FRAMES.length
  const index = (((whole + offset) % HANDS_FRAMES.length) + HANDS_FRAMES.length) % HANDS_FRAMES.length
  return {
    current: HANDS_FRAMES[index] ?? 'rest',
    next: HANDS_FRAMES[(index + 1) % HANDS_FRAMES.length] ?? 'rest',
    mix: framePosition - whole,
  }
}

export function propStillAsset(type: string, state: string): ThreeBranchesAssetName {
  const asset = PRESENTATION.props.stateAssets[type]?.[state]
  if (asset === undefined) throw new Error(`no artwork for ${type} state ${state}`)
  return asset
}

export function emissiveAsset(type: string, state: string): ThreeBranchesAssetName | null {
  const config = PRESENTATION.props.emissiveStates[type]
  return config?.state === state ? config.asset : null
}

export interface ActiveEffectPresentation {
  asset: ThreeBranchesAssetName
  postGrade: boolean
  alpha: number
  rotation: number
  offset: number
}

export function activeEffectFor(
  type: string,
  state: string,
  tick: number,
  id: string,
): ActiveEffectPresentation | null {
  const config = PRESENTATION.props.activeEffects[type]
  if (config === undefined || config.state !== state) return null
  const phase = ((tick + stableHash(id)) % config.periodTicks) / config.periodTicks
  const wave = Math.sin(phase * Math.PI * 2)
  return {
    asset: config.asset,
    postGrade: config.postGrade,
    alpha: 0.72 + wave * 0.14,
    rotation: type === 'bell' ? wave * 0.16 : 0,
    offset:
      type === 'shrine'
        ? -((1 - Math.cos(phase * Math.PI * 2)) / 2) * 7
        : type === 'pump'
          ? wave * 3
          : 0,
  }
}

export function phaseGradeFor(phase: string): { color: string; alpha: number } {
  return PRESENTATION.phaseGrades[(PHASES.includes(phase as DayPhase) ? phase : 'day') as DayPhase]
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value)
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`presentation fields must be exactly ${expected.join(', ')}`)
  }
}

function color(value: unknown, name: string): void {
  if (typeof value !== 'string' || !HEX_COLOR.test(value))
    throw new Error(`${name} must be a lowercase hex color`)
}

function paletteColor(value: unknown, name: string): void {
  if (typeof value !== 'string' || !HEARTHSIDE_STYLE_KEYS.includes(value as HearthsideColorName)) {
    throw new Error(`${name} is not in the Hearthside palette`)
  }
}

function positive(value: unknown, name: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new Error(`${name} must be positive`)
}

function positiveInteger(value: unknown, name: string): void {
  positive(value, name)
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`)
}

function numberBetween(value: unknown, low: number, high: number, name: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) {
    throw new Error(`${name} must be from ${low} through ${high}`)
  }
}

function stringRecord(value: unknown, name: string): Record<string, string> {
  const result = object(value, `${name} must be an object`)
  if (Object.values(result).some((item) => typeof item !== 'string'))
    throw new Error(`${name} values must be text`)
  return result as Record<string, string>
}

function arrayRecord(value: unknown, name: string): Record<string, string[]> {
  const result = object(value, `${name} must be an object`)
  for (const item of Object.values(result)) {
    if (!Array.isArray(item) || item.some((entry) => typeof entry !== 'string')) {
      throw new Error(`${name} values must be text arrays`)
    }
  }
  return result as Record<string, string[]>
}

function nestedStringRecord(value: unknown, name: string): Record<string, Record<string, string>> {
  const result = object(value, `${name} must be an object`)
  return Object.fromEntries(
    Object.entries(result).map(([key, item]) => [key, stringRecord(item, `${name} ${key}`)]),
  )
}

function assetName(value: unknown, name: string): asserts value is ThreeBranchesAssetName {
  if (typeof value !== 'string' || !ASSET_NAME.test(value) || !ASSET_NAMES.has(value))
    throw new Error(`${name} asset name is invalid`)
}
