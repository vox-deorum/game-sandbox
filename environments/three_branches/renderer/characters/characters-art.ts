import { degreesToRadians, stableHashParts } from '@renderers/base/math.js'

import {
  type CharacterCastSet,
  HEARTHSIDE_STYLE,
  type HearthsidePaletteKey,
} from '../core/presentation.js'

/** The selected full-color cast set and its far-view mark treatment. */
export interface CharacterStyle {
  set: CharacterCastSet
  farMarkTint: HearthsidePaletteKey
}

/** Select a cast set without depending on roster order or renderer history. */
export function characterStyle(playerId: string): CharacterStyle {
  const set =
    playerId === 'player_0'
      ? HEARTHSIDE_STYLE.characters.cast.visitor
      : pick(
          HEARTHSIDE_STYLE.characters.cast.villagers,
          stableHashParts('character-cast', playerId),
        )
  return { set, farMarkTint: set.farMarkTint }
}

export interface CharacterGait {
  leftArm: { rotation: number; travel: number }
  rightArm: { rotation: number; travel: number }
  body: { rotation: number; bob: number }
}

/** Compute one seek-safe top-down gait from displayed walked distance and movement. */
export function characterGait(walkDistance: number, walkBlend: number): CharacterGait {
  const walk = HEARTHSIDE_STYLE.characters.walk
  const phase = (2 * Math.PI * walkDistance) / (walk.frameRatio * 4)
  const strength = Math.max(0, Math.min(1, walkBlend))
  if (strength === 0) {
    return {
      leftArm: { rotation: 0, travel: 0 },
      rightArm: { rotation: 0, travel: 0 },
      body: { rotation: 0, bob: 0 },
    }
  }

  const leftWave = gaitWave(phase)
  const rightWave = gaitWave(phase + Math.PI)
  return {
    leftArm: {
      rotation: walk.armAmplitudeRadians * leftWave * strength,
      travel: walk.armTravelPixels * leftWave * strength,
    },
    rightArm: {
      rotation: -walk.armAmplitudeRadians * rightWave * strength,
      travel: walk.armTravelPixels * rightWave * strength,
    },
    body: {
      rotation: walk.bodySwayRadians * Math.sin(phase) * strength,
      bob: -walk.bodyBobPixels * Math.sin(phase) ** 2 * strength,
    },
  }
}

/** Turn a north-authored sprite to an exact environment heading in Pixi screen axes. */
export function characterRotation(heading: number): number {
  return degreesToRadians(270 - heading)
}

function pick<Value>(values: readonly Value[], hash: number): Value {
  const value = values[hash % values.length]
  if (value === undefined) throw new Error('Three Branches character cast pool is empty.')
  return value
}

function gaitWave(phase: number): number {
  return (Math.sin(phase) + 0.14 * Math.sin(phase * 2)) / 1.14
}
