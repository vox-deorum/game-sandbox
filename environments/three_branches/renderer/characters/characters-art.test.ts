import { describe, expect, it } from 'vitest'
import { HEARTHSIDE_STYLE } from '../core/presentation.js'
import { characterArmAngles, characterRotation, characterStyle } from './characters-art.js'

describe('Three Branches character art choices', () => {
  it('selects the visitor and all three villager sets deterministically', () => {
    expect(characterStyle('player_0').set.id).toBe('visitor')
    const ids = Array.from({ length: 100 }, (_, index) => `player_${index + 1}`)
    const styles = ids.map(characterStyle)
    const villagers = HEARTHSIDE_STYLE.characters.cast.villagers
    expect(styles.every((style) => villagers.some((set) => set.id === style.set.id))).toBe(true)
    expect(new Set(styles.map((style) => style.set.id))).toEqual(
      new Set(villagers.map((set) => set.id)),
    )
    expect(ids.map((id) => characterStyle(id).set.id)).toEqual(
      ids.map((id) => characterStyle(id).set.id),
    )
  })

  it('keeps configured full-color frames, marks, pivots, and anchors', () => {
    const sets = [HEARTHSIDE_STYLE.characters.cast.visitor, ...HEARTHSIDE_STYLE.characters.cast.villagers]
    expect(sets).toHaveLength(4)
    for (const set of sets) {
      expect(set.base).toMatch(/Base$/)
      expect(set.leftArm.frame).toMatch(/LeftArm$/)
      expect(set.rightArm.frame).toMatch(/RightArm$/)
      expect(set.leftArm.pivot).toEqual({ x: 49, y: 78 })
      expect(set.rightArm.pivot).toEqual({ x: 143, y: 78 })
      expect(set.leftArm.anchor).toEqual(set.leftArm.pivot)
      expect(set.rightArm.anchor).toEqual(set.rightArm.pivot)
    }
  })

  it('animates opposing arms from walk distance and settles them with moved strength', () => {
    const { frameRatio, armAmplitudeRadians } = HEARTHSIDE_STYLE.characters.walk
    const playerId = 'player_7'
    const still = characterArmAngles(playerId, frameRatio, 0)
    expect(still).toEqual({ left: 0, right: 0 })

    const distance = frameRatio * 0.75
    const angles = characterArmAngles(playerId, distance, frameRatio)
    expect(angles.left).toBeCloseTo(-angles.right)
    expect(Math.abs(angles.left)).toBeLessThanOrEqual(armAmplitudeRadians)
    expect(characterArmAngles(playerId, distance, frameRatio)).toEqual(angles)
    expect(characterArmAngles(playerId, distance, 0)).toEqual({ left: 0, right: 0 })
    expect(characterArmAngles(playerId, distance, frameRatio * 2)).toEqual(angles)
  })

  it('gives fixed player ids stable, distinct walk phases at the same distance', () => {
    const distance = HEARTHSIDE_STYLE.characters.walk.frameRatio * 0.25
    const ids = ['player_1', 'player_2', 'player_3', 'player_4']
    const angles = ids.map((id) => characterArmAngles(id, distance, 0.5))
    expect(new Set(angles.map((value) => value.left)).size).toBeGreaterThan(1)
    expect(ids.map((id) => characterArmAngles(id, distance, 0.5))).toEqual(angles)
  })

  it('rotates the north-authored sprite to exact recorded headings', () => {
    expect(characterRotation(90)).toBeCloseTo(0)
    expect(characterRotation(0)).toBeCloseTo(Math.PI / 2)
    expect(characterRotation(180)).toBeCloseTo(-Math.PI / 2)
  })
})
