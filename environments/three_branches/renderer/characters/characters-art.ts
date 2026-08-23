import { degreesToRadians, stableHashParts } from '@renderers/base/math.js'

import {
  HEARTHSIDE_STYLE,
  type CharacterCastSet,
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

/** Compute the seek-safe opposing shoulder swing at one displayed walked distance. */
export function characterArmAngles(
  playerId: string,
  walkDistance: number,
  moved: number,
): { left: number; right: number } {
  const { frameRatio, armAmplitudeRadians } = HEARTHSIDE_STYLE.characters.walk
  const phaseOffset = stableHashParts('character-walk', playerId) % 4
  const phase = (2 * Math.PI * walkDistance) / (frameRatio * 4) + phaseOffset * (Math.PI / 2)
  const strength = Math.max(0, Math.min(1, moved / frameRatio))
  if (strength === 0) return { left: 0, right: 0 }
  const swing = armAmplitudeRadians * Math.sin(phase) * strength
  return { left: swing, right: -swing }
}

/** Turn a north-authored sprite to an exact environment heading in Pixi screen axes. */
export function characterRotation(heading: number): number {
  return degreesToRadians(90 - heading)
}

function pick<Value>(values: readonly Value[], hash: number): Value {
  const value = values[hash % values.length]
  if (value === undefined) throw new Error('Three Branches character cast pool is empty.')
  return value
}
