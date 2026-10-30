import { Container, type Graphics, Texture } from 'pixi.js'
import { describe, expect, it, vi } from 'vitest'
import { HEARTHSIDE_STYLE, THREE_BRANCHES_PRESENTATION } from '../core/presentation.js'
import { fixtureRecording } from '../core/test-helpers.js'
import type { FrameScene } from '../core/types.js'
import { dayLightAt } from '../effects/post-effects.js'
import { buildStaticScene, computeScene } from '../map/scene.js'
import { expectedCharacterIds, readStatic } from '../ui/overlay.js'
import { type CharacterArt, createCharacterLayer } from './characters.js'

const NOON = dayLightAt(null, 0).shadow

function characterArt(): CharacterArt {
  const sets = [
    HEARTHSIDE_STYLE.characters.cast.visitor,
    ...HEARTHSIDE_STYLE.characters.cast.villagers,
  ]
  return {
    sets: Object.fromEntries(
      sets.map((set) => [
        set.id,
        { base: Texture.WHITE, leftArm: Texture.WHITE, rightArm: Texture.WHITE },
      ]),
    ),
    shadow: Texture.WHITE,
    directionMark: Texture.WHITE,
  }
}

function fixtureScene(): FrameScene {
  const { header, states } = fixtureRecording()
  const staticScene = buildStaticScene(readStatic(header))
  return computeScene(
    states[0] as (typeof states)[number],
    staticScene,
    expectedCharacterIds(header),
  )
}

function descendant(root: Container, label: string): Container {
  const pending = [...root.children]
  while (pending.length > 0) {
    const child = pending.shift()
    if (child === undefined) break
    if (child.label === label) return child as Container
    pending.push(...(child as Container).children)
  }
  throw new Error(`Missing character node: ${label}`)
}

describe('Three Branches retained characters', () => {
  it('installs one assembled sprite per stable id and removes departed ids', () => {
    const view = new Container()
    const characters = createCharacterLayer(view)
    const scene = fixtureScene()
    const fittedZoom = 2
    const closeZoom = fittedZoom * THREE_BRANCHES_PRESENTATION.farMarkZoomFactor

    characters.reconcile(scene, closeZoom, fittedZoom, NOON)
    const visitorBefore = descendant(view, 'character:player_0')
    expect(descendant(visitorBefore, 'character-fallback').visible).toBe(true)

    characters.install(characterArt())
    characters.reconcile(scene, closeZoom, fittedZoom, NOON)
    expect(view.children).toHaveLength(scene.characters.length)
    expect(descendant(view, 'character:player_0')).toBe(visitorBefore)
    for (const label of [
      'character-shadow',
      'character-rotor',
      'character-gait',
      'character-base',
      'character-left-arm',
      'character-right-arm',
      'character-direction-mark',
    ]) {
      expect(descendant(visitorBefore, label)).toBeDefined()
    }
    expect(descendant(visitorBefore, 'character-fallback').visible).toBe(false)

    const trimmed = { ...scene, characters: scene.characters.slice(1) }
    characters.reconcile(trimmed, closeZoom, fittedZoom, NOON)
    expect(view.children).toHaveLength(trimmed.characters.length)
    expect(view.children.some((child) => child.label === 'character:player_0')).toBe(false)
  })

  it('uses far marks below the far-mark zoom and full sprites at and above it', () => {
    const view = new Container()
    const characters = createCharacterLayer(view)
    const scene = fixtureScene()
    const fittedZoom = 2
    const threshold = fittedZoom * THREE_BRANCHES_PRESENTATION.farMarkZoomFactor
    characters.install(characterArt())

    characters.reconcile(scene, threshold - 0.01, fittedZoom, NOON)
    const visitor = descendant(view, 'character:player_0')
    expect(descendant(visitor, 'character-far-mark').visible).toBe(true)
    expect(descendant(visitor, 'character-rotor').visible).toBe(false)

    characters.reconcile(scene, threshold, fittedZoom, NOON)
    expect(descendant(visitor, 'character-far-mark').visible).toBe(false)
    expect(descendant(visitor, 'character-rotor').visible).toBe(true)
  })

  it('turns a far mark with its character without repainting its shape', () => {
    const view = new Container()
    const characters = createCharacterLayer(view)
    const scene = fixtureScene()
    const fittedZoom = 2
    const farZoom = fittedZoom * THREE_BRANCHES_PRESENTATION.farMarkZoomFactor - 0.01
    characters.install(characterArt())
    characters.reconcile(scene, farZoom, fittedZoom, NOON)
    const mark = descendant(
      descendant(view, 'character:player_0'),
      'character-far-mark',
    ) as Graphics
    const before = mark.rotation
    const clear = vi.spyOn(mark, 'clear')

    const turned: FrameScene = {
      ...scene,
      characters: scene.characters.map((character) => ({
        ...character,
        heading: character.heading + 90,
      })),
    }
    characters.reconcile(turned, farZoom, fittedZoom, NOON)
    expect(mark.rotation).not.toBe(before)
    expect(clear).not.toHaveBeenCalled()
  })

  it('keeps the full-color base static while the gait moves the canonical arm pair', () => {
    const view = new Container()
    const characters = createCharacterLayer(view)
    const scene = fixtureScene()
    characters.install(characterArt())
    const walking = {
      ...scene,
      characters: scene.characters.map((character, index) =>
        index === 0 ? { ...character, walkDistance: 0.23, moved: 0.5, walkBlend: 1 } : character,
      ),
    }

    characters.reconcile(walking, 8, 2, NOON)
    const visitor = descendant(view, 'character:player_0')
    const base = descendant(visitor, 'character-base') as unknown as { texture: Texture }
    const left = descendant(visitor, 'character-left-arm') as unknown as {
      rotation: number
      position: { y: number }
    }
    const right = descendant(visitor, 'character-right-arm') as unknown as {
      rotation: number
      position: { y: number }
    }
    expect(base.texture).toBe(Texture.WHITE)
    expect(left.rotation).not.toBe(0)
    expect(right.rotation).not.toBe(0)
    expect(left.position.y).not.toBe(right.position.y)
    expect(descendant(visitor, 'character-shadow').visible).toBe(true)
  })

  it('lays the drop shadow along the sun, longer and fainter when the sun is low', () => {
    const view = new Container()
    const characters = createCharacterLayer(view)
    const scene = fixtureScene()
    characters.install(characterArt())
    const shadowOf = (): Container =>
      descendant(descendant(view, 'character:player_0'), 'character-shadow')

    characters.reconcile(scene, 8, 2, NOON)
    const noon = shadowOf()
    const noonReach = Math.hypot(noon.position.x, noon.position.y)
    const noonAlpha = noon.alpha

    const dawn = dayLightAt('dawn', 1).shadow
    characters.reconcile(scene, 8, 2, dawn)
    const low = shadowOf()
    expect(Math.hypot(low.position.x, low.position.y)).toBeGreaterThan(noonReach)
    expect(Math.atan2(low.position.y, low.position.x)).toBeCloseTo(
      (dawn.angleDegrees * Math.PI) / 180 - Math.PI * 2,
    )
    expect(low.alpha).toBe(dawn.alpha)
    expect(low.alpha).toBeLessThan(noonAlpha)
  })
})
