import { degreesToRadians, stableHashParts } from '@renderers/base/math.js'

import { HEARTHSIDE_STYLE, type HearthsidePaletteKey } from '../core/presentation.js'

const walkFrames = HEARTHSIDE_STYLE.characters.walk.frames

/** Configured still frame shared by every assembled character. */
export const CHARACTER_REST_FRAME = requiredFrame(walkFrames[0], 'rest')

/** The configured short seek-safe walking loop shared by every assembled character. */
export const CHARACTER_WALK_CYCLE = [
  requiredFrame(walkFrames[1], 'first walking'),
  requiredFrame(walkFrames[2], 'passing'),
  requiredFrame(walkFrames[3], 'second walking'),
  requiredFrame(walkFrames[2], 'passing'),
] as const

/** Stable palette and optional clothing detail selected for one player id. */
export interface CharacterStyle {
  clothingTint: HearthsidePaletteKey
  detail: string | null
  detailTint: HearthsidePaletteKey
  markTint: HearthsidePaletteKey
}

/** Select one character treatment without depending on roster order or renderer history. */
export function characterStyle(playerId: string): CharacterStyle {
  const tints = HEARTHSIDE_STYLE.characters.clothingTints
  const clothingTint = pick(tints, stableHashParts('character-clothing', playerId))
  if (playerId === 'player_0') {
    const visitor = HEARTHSIDE_STYLE.characters.visitor
    return {
      clothingTint,
      detail: visitor.detail,
      detailTint: visitor.tint,
      markTint: visitor.tint,
    }
  }

  const details = HEARTHSIDE_STYLE.characters.details
  const detailIndex = stableHashParts('character-detail', playerId) % (details.length + 1)
  const detail = detailIndex === details.length ? null : (details[detailIndex] ?? null)
  const detailTint = pick(tints, stableHashParts('character-detail-tint', playerId))
  return { clothingTint, detail, detailTint, markTint: clothingTint }
}

/** Resolve the exact pose at one fractional recorded tick. A still character always rests. */
export function characterWalkFrame(
  playerId: string,
  fractionalTick: number,
  moved: number,
): string {
  if (moved <= 0) return CHARACTER_REST_FRAME
  const elapsedFrames = Math.floor(fractionalTick / HEARTHSIDE_STYLE.characters.walk.frameRatio)
  const playerPhase = stableHashParts('character-walk', playerId) % CHARACTER_WALK_CYCLE.length
  return CHARACTER_WALK_CYCLE[(elapsedFrames + playerPhase) % CHARACTER_WALK_CYCLE.length]!
}

/** Turn a north-authored sprite to an exact environment heading in Pixi screen axes. */
export function characterRotation(heading: number): number {
  return degreesToRadians(90 - heading)
}

function pick<Value>(values: readonly Value[], hash: number): Value {
  const value = values[hash % values.length]
  if (value === undefined) throw new Error('Three Branches character style pool is empty.')
  return value
}

function requiredFrame(frame: string | undefined, role: string): string {
  if (frame === undefined) throw new Error(`Three Branches character ${role} frame is missing.`)
  return frame
}
