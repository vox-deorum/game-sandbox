import { describe, expect, it } from 'vitest'

import propsData from '../props.json'
import {
  loadThreeBranchesAssets,
  THREE_BRANCHES_ASSET_MANIFEST,
  threeBranchesAssetSources,
} from './assets.js'
import { spriteRotationForHeading } from './characters.js'
import { cranePresentationFor } from './cranes.js'
import { WORLD_LAYER_ORDER } from './index.js'
import {
  activeEffectFor,
  HEARTHSIDE_STYLE,
  handsFrameFor,
  headAssetFor,
  phaseGradeFor,
  presentationFor,
  propStillAsset,
  showsGroundMark,
  validatePresentation,
  variantFor,
} from './presentation.js'
import rawPresentation from './presentation.json'
import { staticScene } from './scene.js'
import { staticOverlay } from './test-helpers.js'

describe('Hearthside presentation contract', () => {
  it('exports the exact approved palette and keeps tuning outside generation data', () => {
    expect(HEARTHSIDE_STYLE).toEqual({
      backdrop: '#101816',
      parchment: '#cfc5a9',
      bone: '#efe7d3',
      ink: '#6f6757',
      reed: '#a9ae8a',
      silt: '#bfa072',
      water: '#5a7680',
      pine: '#4f6a4b',
      indigo: '#27436b',
      cinnabar: '#b0402e',
      gilt: '#d9a441',
      violet: '#6b5d72',
      timber: '#8a6246',
    })
    expect(validatePresentation(structuredClone(rawPresentation))).toEqual(rawPresentation)
    expect(rawPresentation).not.toHaveProperty('channels')
    const invalid = structuredClone(rawPresentation) as Record<string, unknown>
    delete invalid.phaseGrades
    expect(() => validatePresentation(invalid)).toThrow(/presentation fields/)
  })

  it('loads the complete manifest through Vite URLs and an injectable loader', async () => {
    expect(THREE_BRANCHES_ASSET_MANIFEST).toHaveLength(65)
    expect(Object.keys(threeBranchesAssetSources())).toHaveLength(65)
    const loaded = await loadThreeBranchesAssets(async (asset) => `loaded:${asset.name}`)
    expect(Object.keys(loaded)).toHaveLength(65)
    expect(loaded.characterHands).toBe('loaded:characterHands')
  })

  it('maps one distinct still to every catalog state', () => {
    const names = new Set(THREE_BRANCHES_ASSET_MANIFEST.map((asset) => asset.name))
    const stills = propsData.props.flatMap((prop) =>
      prop.states.map((state) => propStillAsset(prop.token, state)),
    )
    expect(new Set(stills).size).toBe(stills.length)
    expect(stills.every((name) => names.has(name))).toBe(true)
  })

  it('uses the exact compact, simple, and detailed CSS-width boundaries', () => {
    expect(presentationFor(11.999)).toBe('compact')
    expect(presentationFor(12)).toBe('simple')
    expect(presentationFor(23.999)).toBe('simple')
    expect(presentationFor(24)).toBe('detailed')
  })

  it('keeps character choices and walking frames stable across direct seeks', () => {
    expect(headAssetFor('visitor')).toBe('visitorHead')
    expect(headAssetFor('npc_3')).toBe(headAssetFor('npc_3'))
    expect(handsFrameFor(137, 'npc_3', 20)).toBe(handsFrameFor(137, 'npc_3', 20))
    expect(handsFrameFor(137, 'npc_3', 0)).toBe('rest')
    expect(spriteRotationForHeading(0)).toBeCloseTo(Math.PI / 2)
    expect(spriteRotationForHeading(270)).toBeCloseTo(Math.PI * 2)
  })

  it('derives active effects only from tick, id, and state', () => {
    const first = activeEffectFor('bell', 'ringing', 221, 'bell_0')
    expect(first).toEqual(activeEffectFor('bell', 'ringing', 221, 'bell_0'))
    expect(activeEffectFor('bell', 'silent', 221, 'bell_0')).toBeNull()
    expect(activeEffectFor('pump', 'flowing', 1, 'pump_0')).not.toEqual(
      activeEffectFor('pump', 'flowing', 900, 'pump_0'),
    )
  })

  it('keeps crane flight deterministic across a direct seek', () => {
    const layoutKey = staticScene(staticOverlay).layoutKey
    expect(cranePresentationFor(layoutKey, 0, 87)).toEqual(cranePresentationFor(layoutKey, 0, 87))
    expect(cranePresentationFor(layoutKey, 0, 1)).not.toEqual(
      cranePresentationFor(layoutKey, 0, 999),
    )
  })

  it('keeps day neutral and places grade, emissives, and collision in contract order', () => {
    expect(phaseGradeFor('day').alpha).toBe(0)
    expect(phaseGradeFor('night').alpha).toBeGreaterThan(0)
    expect(phaseGradeFor('unknown')).toEqual(phaseGradeFor('day'))
    expect(WORLD_LAYER_ORDER).toEqual([
      'ground-and-washes',
      'lower-village',
      'props',
      'characters',
      'upper-village-and-effects',
      'phase-grade',
      'emissives',
      'collision',
    ])
  })

  it('selects ground marks from the static-layout key without replay history', () => {
    const layoutKey = staticScene(staticOverlay).layoutKey
    const variants = Array.from({ length: 20 }, (_, column) =>
      variantFor(layoutKey, 'r', column, 7),
    )
    expect(variants).toEqual(
      Array.from({ length: 20 }, (_, column) => variantFor(layoutKey, 'r', column, 7)),
    )
    expect(new Set(variants).size).toBeGreaterThan(1)
    const marks = Array.from({ length: 100 }, (_, column) => showsGroundMark(layoutKey, column, 7))
    expect(marks).toEqual(
      Array.from({ length: 100 }, (_, column) => showsGroundMark(layoutKey, column, 7)),
    )
    expect(marks.filter(Boolean).length).toBeGreaterThan(5)
    expect(marks.filter(Boolean).length).toBeLessThan(40)
  })
})
