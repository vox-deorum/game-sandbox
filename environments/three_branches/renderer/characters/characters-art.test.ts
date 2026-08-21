import { describe, expect, it } from 'vitest'
import { HEARTHSIDE_STYLE } from '../core/presentation.js'
import {
  CHARACTER_REST_FRAME,
  CHARACTER_WALK_CYCLE,
  characterRotation,
  characterStyle,
  characterWalkFrame,
} from './characters-art.js'

describe('Three Branches character art choices', () => {
  it('selects allowed villager tints and optional details deterministically by player id', () => {
    const ids = Array.from({ length: 40 }, (_, index) => `player_${index + 1}`)
    const styles = ids.map(characterStyle)

    expect(
      styles.every((style) =>
        HEARTHSIDE_STYLE.characters.clothingTints.includes(style.clothingTint),
      ),
    ).toBe(true)
    expect(
      styles.every(
        (style) =>
          style.detail === null || HEARTHSIDE_STYLE.characters.details.includes(style.detail),
      ),
    ).toBe(true)
    expect(styles.some((style) => style.detail === null)).toBe(true)
    expect(styles.some((style) => style.detail !== null)).toBe(true)
  })

  it('gives the visitor its configured detail and tint for both the tie and far mark', () => {
    const visitor = characterStyle('player_0')
    const visitorTint = HEARTHSIDE_STYLE.characters.visitor.tint

    expect(HEARTHSIDE_STYLE.characters.clothingTints).toContain(visitor.clothingTint)
    expect(visitor).toMatchObject({
      detail: HEARTHSIDE_STYLE.characters.visitor.detail,
      detailTint: visitorTint,
      markTint: visitorTint,
    })
  })

  it('rests while still and advances the four-pose walk cycle from walked distance', () => {
    const playerId = 'player_7'
    const frameRatio = HEARTHSIDE_STYLE.characters.walk.frameRatio
    const poseDistances = CHARACTER_WALK_CYCLE.map((_, index) => (index + 0.25) * frameRatio)
    const frames = poseDistances.map((distance) => characterWalkFrame(playerId, distance, 0.5))
    const rotations = CHARACTER_WALK_CYCLE.map((_, offset) =>
      CHARACTER_WALK_CYCLE.map(
        (_, index) => CHARACTER_WALK_CYCLE[(index + offset) % CHARACTER_WALK_CYCLE.length],
      ),
    )

    expect(characterWalkFrame(playerId, 18.75 * frameRatio, 0)).toBe(CHARACTER_REST_FRAME)
    expect(rotations).toContainEqual(frames)
  })

  it('gives fixed player ids stable, distinct walk phases at the same walked distance', () => {
    const { frameRatio } = HEARTHSIDE_STYLE.characters.walk
    const distance = 0.25 * frameRatio
    const ids = ['player_1', 'player_2', 'player_3', 'player_4']

    const frames = ids.map((id) => characterWalkFrame(id, distance, 0.5))
    // One id owns one phase: repeating the id keeps its frame, and the ids spread across the walk
    // cycle's entries at the same walked distance.
    expect(new Set(frames).size).toBeGreaterThan(1)
    // Crossing a full frame ratio advances the walk one pose and never repeats the same one.
    expect(characterWalkFrame(ids[0]!, frameRatio * 0.999, 0.5)).toBe(frames[0])
    expect(characterWalkFrame(ids[0]!, frameRatio * 1.001, 0.5)).not.toBe(frames[0])
  })

  it('rotates the north-authored sprite to exact recorded headings', () => {
    expect(characterRotation(90)).toBeCloseTo(0)
    expect(characterRotation(0)).toBeCloseTo(Math.PI / 2)
    expect(characterRotation(180)).toBeCloseTo(-Math.PI / 2)
  })
})
