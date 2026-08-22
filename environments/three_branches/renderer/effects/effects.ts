import { stableHashParts } from '@renderers/base/math.js'

import { HEARTHSIDE_STYLE, type HearthsidePaletteKey } from '../core/presentation.js'

/** One seek-safe animated accent placed above the character layer. */
export interface PropEffectSpec {
  frame: string
  tint: HearthsidePaletteKey
  alpha: number
  scale: number
  offsetX: number
  offsetY: number
  rotation: number
  phase: number
}

/** One post-grade light treatment emitted by an active domestic prop. */
export interface EmissiveSpec {
  frame: string
  tint: HearthsidePaletteKey
  alpha: number
  scale: number
}

/** Resolve the seek-safe back-and-forth rotation of the bell around its authored suspension. */
export function bellSwingRotation(state: string, propId: string, fractionalTick: number): number {
  if (state !== 'ringing') return 0
  const phase = stableHashParts('three-branches-prop-effect', 'bell', propId, state)
  const treatment = HEARTHSIDE_STYLE.propEffects.bell
  if (treatment === undefined) throw new Error('Three Branches bell effect treatment is missing.')
  const swing = HEARTHSIDE_STYLE.props.registeredPropByType.bell?.swing
  if (swing === undefined) throw new Error('Three Branches bell swing treatment is missing.')
  const frameCount = requiredFrames(treatment.frames).length
  const cycle = (fractionalTick * treatment.frameRate) / frameCount + phase / 0xffffffff
  return Math.sin(cycle * Math.PI * 2) * swing.amplitudeRadians
}

/** Whether this type and state owns one of the five sustained visual effects. */
export function hasPropEffect(type: string, state: string): boolean {
  return activeEffect(type, state) !== null
}

/** List every animation frame required by one type and state. */
export function propEffectFrames(type: string, state: string): readonly string[] {
  const effect = activeEffect(type, state)
  return effect === null ? [] : requiredFrames(HEARTHSIDE_STYLE.propEffects[effect]?.frames)
}
/** Resolve the only five sustained prop animations from recorded, replay-safe inputs. */
export function propEffectSpec(
  type: string,
  state: string,
  propId: string,
  fractionalTick: number,
): PropEffectSpec | null {
  const effect = activeEffect(type, state)
  if (effect === null) return null
  const phase = stableHashParts('three-branches-prop-effect', effect, propId, state)
  const treatment = HEARTHSIDE_STYLE.propEffects[effect]
  if (treatment === undefined) throw new Error('Three Branches prop effect treatment is missing.')
  const frames = requiredFrames(treatment.frames)
  const frameClock = fractionalTick * treatment.frameRate + (phase / 0xffffffff) * frames.length
  const frame = frameAt(frames, Math.floor(frameClock))
  const wave = Math.sin((frameClock / frames.length) * Math.PI * 2)
  switch (effect) {
    case 'lantern':
      return {
        frame,
        tint: 'gilt',
        alpha: 0.7 + wave * 0.16,
        scale: 0.92 + wave * 0.08,
        offsetX: 0,
        offsetY: 0,
        rotation: 0,
        phase,
      }
    case 'hearth':
      return {
        frame,
        tint: 'cinnabar',
        alpha: 0.82 + wave * 0.12,
        scale: 0.9 + wave * 0.1,
        offsetX: 0,
        offsetY: 1 - wave,
        rotation: 0,
        phase,
      }
    case 'shrine':
      return {
        frame,
        tint: 'violet',
        alpha: 0.45 + wave * 0.16,
        scale: 0.86 + wave * 0.1,
        offsetX: 0,
        offsetY: -4 - wave * 3,
        rotation: wave * 0.08,
        phase,
      }
    case 'pump':
      return {
        frame,
        tint: 'water',
        alpha: 0.72 + wave * 0.14,
        scale: 0.94 + wave * 0.06,
        offsetX: 0,
        offsetY: wave * 2,
        rotation: 0,
        phase,
      }
    case 'bell':
      return {
        frame,
        tint: 'gilt',
        alpha: 0.58 + wave * 0.2,
        scale: 1,
        offsetX: 0,
        offsetY: -5,
        rotation: wave * 0.12,
        phase,
      }
  }
  throw new Error('Three Branches prop effect is unsupported.')
}

/** Resolve the configured post-grade glow for the two light-producing prop states. */
export function emissiveSpec(type: string, state: string): EmissiveSpec | null {
  if (type !== 'lantern' && type !== 'hearth') return null
  if (state !== 'lit') return null
  return {
    frame: HEARTHSIDE_STYLE.emissives.frame,
    tint: HEARTHSIDE_STYLE.emissives[type],
    alpha: type === 'lantern' ? 0.48 : 0.56,
    scale: type === 'lantern' ? 1.1 : 1.3,
  }
}

function activeEffect(
  type: string,
  state: string,
): keyof typeof HEARTHSIDE_STYLE.propEffects | null {
  if (type === 'lantern' && state === 'lit') return 'lantern'
  if (type === 'hearth' && state === 'lit') return 'hearth'
  if (type === 'shrine' && state === 'tended') return 'shrine'
  if (type === 'pump' && state === 'flowing') return 'pump'
  if (type === 'bell' && state === 'ringing') return 'bell'
  return null
}

function requiredFrames(frames: readonly string[] | undefined): readonly string[] {
  if (frames === undefined || frames.length === 0)
    throw new Error('Three Branches prop effect frames are missing.')
  return frames
}

function frameAt(frames: readonly string[], elapsed: number): string {
  return frames[elapsed % frames.length]!
}
