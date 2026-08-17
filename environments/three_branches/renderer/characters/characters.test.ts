import { Container, Texture } from 'pixi.js'
import { describe, expect, it } from 'vitest'
import { THREE_BRANCHES_PRESENTATION } from '../core/presentation.js'
import { fixtureRecording } from '../core/test-helpers.js'
import type { FrameScene } from '../core/types.js'
import { buildStaticScene, computeScene } from '../map/scene.js'
import { nameplateAlpha } from '../ui/annotations.js'
import { expectedCharacterIds, readStatic } from '../ui/overlay.js'
import { type CharacterArt, createCharacterLayer } from './characters.js'

const POSES = ['rest', 'leftForward', 'pass', 'rightForward'] as const
const DETAILS = ['hairKnot', 'reedCap', 'headscarf', 'visitorTie'] as const

function textures(names: readonly string[]): Readonly<Record<string, Texture>> {
  return Object.fromEntries(names.map((name) => [name, Texture.WHITE]))
}

function characterArt(): CharacterArt {
  return {
    body: textures(POSES),
    clothing: textures(POSES),
    arms: textures(POSES),
    details: textures(DETAILS),
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
    const closeZoom = fittedZoom * THREE_BRANCHES_PRESENTATION.nameplateZoomFactor

    characters.reconcile(scene, closeZoom, fittedZoom)
    const visitorBefore = descendant(view, 'character:player_0')
    expect(descendant(visitorBefore, 'character-fallback').visible).toBe(true)

    characters.install(characterArt())
    characters.reconcile(scene, closeZoom, fittedZoom)
    expect(view.children).toHaveLength(scene.characters.length)
    expect(descendant(view, 'character:player_0')).toBe(visitorBefore)
    for (const label of [
      'character-shadow',
      'character-rotor',
      'character-body',
      'character-clothing',
      'character-arms',
      'character-detail',
      'character-direction-mark',
    ]) {
      expect(descendant(visitorBefore, label)).toBeDefined()
    }
    expect(descendant(visitorBefore, 'character-fallback').visible).toBe(false)

    const trimmed = { ...scene, characters: scene.characters.slice(1) }
    characters.reconcile(trimmed, closeZoom, fittedZoom)
    expect(view.children).toHaveLength(trimmed.characters.length)
    expect(view.children.some((child) => child.label === 'character:player_0')).toBe(false)
  })

  it('uses far marks until the shared nameplate readability threshold is fully reached', () => {
    const view = new Container()
    const characters = createCharacterLayer(view)
    const scene = fixtureScene()
    const fittedZoom = 2
    const threshold = fittedZoom * THREE_BRANCHES_PRESENTATION.nameplateZoomFactor
    characters.install(characterArt())

    characters.reconcile(scene, threshold - 0.01, fittedZoom)
    const visitor = descendant(view, 'character:player_0')
    expect(nameplateAlpha(threshold - 0.01, fittedZoom)).toBeLessThan(1)
    expect(descendant(visitor, 'character-far-mark').visible).toBe(true)
    expect(descendant(visitor, 'character-rotor').visible).toBe(false)

    characters.reconcile(scene, threshold, fittedZoom)
    expect(nameplateAlpha(threshold, fittedZoom)).toBe(1)
    expect(descendant(visitor, 'character-far-mark').visible).toBe(false)
    expect(descendant(visitor, 'character-rotor').visible).toBe(true)
  })
})
