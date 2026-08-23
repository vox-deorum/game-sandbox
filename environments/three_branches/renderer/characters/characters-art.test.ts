import { describe, expect, it } from 'vitest'
import { HEARTHSIDE_STYLE } from '../core/presentation.js'
import { characterGait, characterRotation, characterStyle } from './characters-art.js'

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
    const sets = [
      HEARTHSIDE_STYLE.characters.cast.visitor,
      ...HEARTHSIDE_STYLE.characters.cast.villagers,
    ]
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

  it('moves arms fore and aft with restrained rotation and settles the gait at rest', () => {
    const { frameRatio, armAmplitudeRadians, armTravelPixels } = HEARTHSIDE_STYLE.characters.walk
    const still = characterGait(frameRatio, 0)
    expect(still).toEqual({
      leftArm: { rotation: 0, travel: 0 },
      rightArm: { rotation: 0, travel: 0 },
      body: { rotation: 0, bob: 0 },
    })

    const distance = frameRatio * 0.75
    const gait = characterGait(distance, 1)
    expect(gait.leftArm.travel * gait.rightArm.travel).toBeLessThan(0)
    expect(Math.abs(gait.leftArm.rotation)).toBeLessThanOrEqual(armAmplitudeRadians)
    expect(Math.abs(gait.rightArm.rotation)).toBeLessThanOrEqual(armAmplitudeRadians)
    expect(Math.abs(gait.leftArm.travel)).toBeLessThanOrEqual(armTravelPixels)
    expect(Math.abs(gait.rightArm.travel)).toBeLessThanOrEqual(armTravelPixels)
    expect(characterGait(distance, 1)).toEqual(gait)
    expect(characterGait(distance, 2)).toEqual(gait)
  })

  it('eases low displayed movement instead of snapping to full stride', () => {
    const { frameRatio } = HEARTHSIDE_STYLE.characters.walk
    const distance = frameRatio
    const gentle = characterGait(distance, 0.25)
    const full = characterGait(distance, 1)
    expect(Math.abs(gentle.leftArm.travel)).toBeLessThan(Math.abs(full.leftArm.travel))
    expect(Math.abs(gentle.body.rotation)).toBeLessThan(Math.abs(full.body.rotation))
  })

  it('rotates the authored sprite by 180 degrees before applying recorded heading', () => {
    expect(characterRotation(90)).toBeCloseTo(Math.PI)
    expect(characterRotation(0)).toBeCloseTo((Math.PI * 3) / 2)
    expect(characterRotation(180)).toBeCloseTo(Math.PI / 2)
  })
})
