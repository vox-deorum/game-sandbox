import { describe, expect, it } from 'vitest'

import {
  CHARACTER_REST_FRAME,
  CHARACTER_WALK_CYCLE,
  characterRotation,
  characterStyle,
  characterWalkFrame,
} from './characters-art.js'
import { HEARTHSIDE_STYLE } from './presentation.js'

describe('Three Branches character art choices', () => {
  it('selects allowed villager tints and optional details deterministically by player id', () => {
    const ids = Array.from({ length: 40 }, (_, index) => `player_${index + 1}`)
    const styles = ids.map(characterStyle)

    expect(ids.map(characterStyle)).toEqual(styles)
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

  it('gives the visitor the configured cinnabar tie and far-view mark', () => {
    const visitor = characterStyle('player_0')

    expect(HEARTHSIDE_STYLE.characters.clothingTints).toContain(visitor.clothingTint)
    expect(visitor).toMatchObject({
      detail: HEARTHSIDE_STYLE.characters.visitor.detail,
      detailTint: 'cinnabar',
      markTint: 'cinnabar',
    })
  })

  it('rests while still and advances the four-pose walk cycle from fractional tick', () => {
    const playerId = 'player_7'
    const frameTicks = CHARACTER_WALK_CYCLE.map(
      (_, index) =>
        ((index + 0.25) * HEARTHSIDE_STYLE.characters.walk.frameMs) /
        HEARTHSIDE_STYLE.transition.naturalMs,
    )
    const frames = frameTicks.map((tick) => characterWalkFrame(playerId, tick, 0.5))
    const rotations = CHARACTER_WALK_CYCLE.map((_, offset) =>
      CHARACTER_WALK_CYCLE.map(
        (_, index) => CHARACTER_WALK_CYCLE[(index + offset) % CHARACTER_WALK_CYCLE.length],
      ),
    )

    expect(characterWalkFrame(playerId, 18.75, 0)).toBe(CHARACTER_REST_FRAME)
    expect(characterWalkFrame(playerId, frameTicks[0] ?? 0, 0.5)).toBe(frames[0])
    expect(rotations).toContainEqual(frames)
  })

  it('gives fixed player ids distinct stable phases at the same fractional tick', () => {
    const tick =
      (0.25 * HEARTHSIDE_STYLE.characters.walk.frameMs) / HEARTHSIDE_STYLE.transition.naturalMs

    expect(characterWalkFrame('player_2', tick, 0.5)).toBe('leftForward')
    expect(characterWalkFrame('player_4', tick, 0.5)).toBe('rightForward')
    expect(characterWalkFrame('player_1', tick, 0.5)).toBe('pass')
  })

  it('rotates the north-authored sprite to exact recorded headings', () => {
    expect(characterRotation(90)).toBeCloseTo(0)
    expect(characterRotation(0)).toBeCloseTo(Math.PI / 2)
    expect(characterRotation(180)).toBeCloseTo(-Math.PI / 2)
  })
})
