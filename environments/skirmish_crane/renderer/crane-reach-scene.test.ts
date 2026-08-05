import type { StepState } from '@game-sandbox/schema'
import { getRenderer } from '@renderers/registry.js'
import { describe, expect, it } from 'vitest'

import '@renderers/index.js'
import armyLegalityRaw from '../../../frontend/test/fixtures/crane-reach-army-legality.json?raw'
import armyFixture from '../../../frontend/test/fixtures/crane-reach-army-recording.jsonl?raw'
import skirmishLegalityRaw from '../../../frontend/test/fixtures/crane-reach-skirmish-legality.json?raw'
import skirmishFixture from '../../../frontend/test/fixtures/crane-reach-skirmish-recording.jsonl?raw'
import { CRANE_ASSET_MANIFEST, craneAssetSources, loadCraneAssets } from './assets.js'
import {
  captureCuesFor,
  deathSnapshotFor,
  eventBudget,
  eventTargetPositionFor,
  eventTextMetrics,
  gaugeFor,
  hostEase,
  isFreshForwardEvent,
  presentationFor,
  reducedMotionCuesFor,
  shouldRebuildBattlefield,
  transitionFor,
} from './index.js'
import { CRANE_STYLE, computeScene, decodeOverlay } from './scene.js'

interface LegalityEntry {
  opening?: StepState
  tick?: number
  current_activation: string
  path: string
  target: string
}

interface LegalityFixture {
  version: number
  recording: string
  entries: LegalityEntry[]
}

function statesFrom(recording: string): StepState[] {
  return recording
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(1)
    .map((line) => JSON.parse(line) as StepState)
}

const skirmishStates = statesFrom(skirmishFixture)
const armyStates = statesFrom(armyFixture)

function verifyBitVector(encoded: string, bitCount: number): Uint8Array {
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
  expect(bytes).toHaveLength(Math.ceil(bitCount / 8))
  expect((bytes[0] as number) & 1).toBe(1)
  const usedBits = bitCount % 8
  if (usedBits !== 0) {
    const paddingMask = 0xff << usedBits
    expect((bytes.at(-1) as number) & paddingMask).toBe(0)
  }
  return bytes
}

function expectAllowed(bytes: Uint8Array, action: number): void {
  const byte = bytes[Math.floor(action / 8)] as number
  expect(byte & (1 << (action % 8))).not.toBe(0)
}

function verifyLegalityFixture(
  recordingName: string,
  recording: string,
  legalityRaw: string,
  targetBits: number,
): void {
  const lines = recording.split('\n').filter((line) => line.trim().length > 0)
  const header = JSON.parse(lines[0] as string) as Record<string, unknown>
  const states = lines.slice(1).map((line) => JSON.parse(line) as StepState)
  const legality = JSON.parse(legalityRaw) as LegalityFixture

  expect(legality.version).toBe(1)
  expect(legality.recording).toBe(recordingName)
  expect(header).not.toHaveProperty('sidecars')
  expect(recording).not.toContain('"action_mask"')
  expect(recording).not.toContain('"legality"')

  const opening = legality.entries[0]
  expect(opening?.opening?.tick).toBe(0)
  expect(opening?.opening?.agents).toEqual({})
  expect(opening).not.toHaveProperty('tick')

  const actionable = states.filter(
    (state) => ((state.overlay ?? {}) as Record<string, unknown>).a !== null,
  )
  expect(legality.entries).toHaveLength(actionable.length + 1)
  expect(opening?.current_activation).toBe(
    computeScene(opening?.opening as StepState).activation?.playerId,
  )

  for (const [index, state] of actionable.entries()) {
    const entry = legality.entries[index + 1] as LegalityEntry
    expect(entry).not.toHaveProperty('opening')
    expect(entry.tick).toBe(state.tick)
    expect(entry.current_activation).toBe(computeScene(state).activation?.playerId)
  }

  expect(legality.entries).toHaveLength(states.length)
  for (const [index, entry] of legality.entries.entries()) {
    const appliedState = states[index] as StepState
    const actors = Object.entries(appliedState.agents)
      .filter(([, result]) => result.action !== undefined)
      .map(([player]) => player)
    expect(actors).toEqual([entry.current_activation])
    const action = appliedState.agents[entry.current_activation]?.action as
      | { path: number; target: number }
      | undefined
    expect(action).toEqual({ path: expect.any(Number), target: expect.any(Number) })
    expectAllowed(verifyBitVector(entry.path, 1555), action?.path as number)
    expectAllowed(verifyBitVector(entry.target, targetBits), action?.target as number)
  }
}

describe('Crane Reach scene geometry and compact overlay', () => {
  it('registers the public renderer key', () => {
    expect(getRenderer('crane-reach-field')).toBeDefined()
  })

  it('lays out pointy-top axial hexes with the void surround still visible', () => {
    const scene = computeScene(skirmishStates[0] as StepState)
    const origin = scene.tiles.find((tile) => tile.q === 0 && tile.r === 0)
    const east = scene.tiles.find((tile) => tile.q === 1 && tile.r === 0)
    const southeast = scene.tiles.find((tile) => tile.q === 0 && tile.r === 1)
    expect(origin).toBeDefined()
    expect(east).toBeDefined()
    expect(southeast).toBeDefined()
    expect(origin?.corners[0]?.y).toBeLessThan(origin?.center.y as number)
    expect(east?.center.x).toBeCloseTo(
      (origin?.center.x as number) + Math.sqrt(3) * scene.hexRadius,
    )
    expect(southeast?.center.x).toBeCloseTo(
      (origin?.center.x as number) + (Math.sqrt(3) * scene.hexRadius) / 2,
    )
    expect(southeast?.center.y).toBeCloseTo((origin?.center.y as number) + scene.hexRadius * 1.5)
    expect(scene.tiles.some((tile) => tile.terrain === 'void')).toBe(true)
  })

  it('maps every terrain and feature code from the full variant', () => {
    const scene = computeScene(armyStates[0] as StepState)
    expect(scene.tiles.some((tile) => tile.terrain === 'grass')).toBe(true)
    expect(scene.tiles.some((tile) => tile.terrain === 'hill')).toBe(true)
    expect(scene.tiles.some((tile) => tile.terrain === 'water')).toBe(true)
    expect(scene.tiles.some((tile) => tile.feature === 'forest')).toBe(true)
    expect(scene.tiles.some((tile) => tile.feature === 'marsh')).toBe(true)
  })

  it('draws capture zones, all unit types, hit points, and the active unit', () => {
    const scenes = armyStates.map((state) => computeScene(state))
    const scene = scenes.find((candidate) => candidate.zones.length > 0)
    expect(scene?.zones.length).toBeGreaterThan(0)
    expect(new Set(scene?.units.map((unit) => unit.type))).toEqual(
      new Set(['footman', 'archer', 'cavalry']),
    )
    expect(scene?.units.every((unit) => unit.hitPoints > 0)).toBe(true)
    const activeScene = scenes.find((candidate) => candidate.activation !== null)
    expect(activeScene?.activation).not.toBeNull()
    expect(activeScene?.units.some((unit) => unit.unitId === activeScene.activation?.unitId)).toBe(
      true,
    )
  })

  it('keeps the most recent activation event as drawable scene content', () => {
    const scene = armyStates
      .map((state) => computeScene(state))
      .find((candidate) => candidate.event !== null)
    expect(scene?.event?.actorId).toMatch(/^(red|blue)_(footman|archer|cavalry)_\d+$/)
    expect(scene?.event?.from).toEqual(
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    )
    expect(scene?.event?.to).toEqual(
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    )
  })

  it('keeps HUD and terminal state in the scene rather than renderer history', () => {
    const first = computeScene(skirmishStates[0] as StepState)
    const final = computeScene(skirmishStates.at(-1) as StepState)
    expect(first.hud.round).toMatch(/^Round /)
    expect(first.hud.capture).toMatch(/^(Capture|Control) {2}Red /)
    expect(final.hud.terminal).toMatch(/^Battle complete/)
  })

  it('is deterministic when a replay seeks to a previously rendered state', () => {
    const selected = armyStates[Math.floor(armyStates.length / 2)] as StepState
    const before = computeScene(selected)
    for (const state of armyStates) computeScene(state)
    expect(computeScene(selected)).toEqual(before)
  })

  it('rejects unsupported compact overlay versions', () => {
    const state: StepState = {
      schema_version: 1,
      tick: 0,
      agents: {},
      timing: { started_at: 0, duration_ms: 0 },
      overlay: { k: 2 },
    }
    expect(() => decodeOverlay(state)).toThrow('only supports compact overlay version 1')
  })
})

describe('Crane Reach scene performance', () => {
  it('computes every army recording frame within the pinned smoke budget', () => {
    const started = performance.now()
    for (const state of armyStates) computeScene(state)
    const elapsedMs = performance.now() - started
    expect(elapsedMs).toBeLessThan(5_000)
  })
})

describe('Crane Reach Estuary Ink presentation', () => {
  it('switches artwork at the exact CSS-radius boundaries without changing scene geometry', () => {
    expect(presentationFor(18, 1)).toMatchObject({ level: 'figure', effectiveHexRadius: 18 })
    expect(presentationFor(17.999, 1).level).toBe('token')
    expect(presentationFor(12, 1).level).toBe('token')
    expect(presentationFor(11.999, 1).level).toBe('compact')
  })

  it('maps maximum hit points to healthy, low, and critical gauge states at both boundaries', () => {
    expect(gaugeFor({ type: 'footman', hitPoints: 12 })).toMatchObject({
      fraction: 1,
      color: CRANE_STYLE.text,
      critical: false,
    })
    expect(gaugeFor({ type: 'footman', hitPoints: 6 })).toMatchObject({
      fraction: 0.5,
      color: CRANE_STYLE.hpLow,
      critical: false,
    })
    expect(gaugeFor({ type: 'footman', hitPoints: 3 })).toMatchObject({
      fraction: 0.25,
      color: CRANE_STYLE.danger,
      critical: true,
    })
    expect(gaugeFor({ type: 'archer', hitPoints: 2 })).toMatchObject({
      fraction: 2 / 6,
      critical: false,
    })
    expect(gaugeFor({ type: 'archer', hitPoints: 6 }).fraction).toBe(1)
    expect(gaugeFor({ type: 'cavalry', hitPoints: 10 }).fraction).toBe(1)
  })

  it('keeps one typed 30-source loading contract and makes it injectable without decoding', async () => {
    expect(CRANE_ASSET_MANIFEST).toHaveLength(30)
    expect(CRANE_ASSET_MANIFEST.every((asset) => asset.path.endsWith('.png'))).toBe(true)
    expect(CRANE_ASSET_MANIFEST.every((asset) => asset.width > 0 && asset.height > 0)).toBe(true)
    expect(Object.keys(craneAssetSources())).toHaveLength(30)
    const loaded = await loadCraneAssets(async (asset) => `stub:${asset.name}`)
    expect(loaded.paperField).toBe('stub:paperField')
    expect(loaded.figCavalry).toBe('stub:figCavalry')
  })

  it('fits events inside the prescribed cadence budget and snaps a zero-duration seek', () => {
    expect(eventBudget()).toBe(450)
    expect(eventBudget({ transitionMs: 300 })).toBe(270)
    expect(eventBudget({ transitionMs: 1_000 })).toBe(450)
    expect(eventBudget({ snap: true, transitionMs: 0 })).toBe(0)
    expect(hostEase(0)).toBe(0)
    expect(hostEase(0.2)).toBeCloseTo(0.5, 4)
    expect(hostEase(1)).toBe(1)
    const compactMetrics = eventTextMetrics(390 / 1_200)
    expect(compactMetrics.size * (390 / 1_200)).toBeCloseTo(12)
    expect(compactMetrics.rise * (390 / 1_200)).toBeCloseTo(12)
  })

  it('only animates a fresh forward event and retains the preceding victim for a death dissolve', () => {
    const before = computeScene(armyStates[0] as StepState)
    const victim = before.units[0]
    const sourceEvent = armyStates
      .map((state) => computeScene(state))
      .find((scene) => scene.event !== null)?.event
    expect(victim).toBeDefined()
    expect(sourceEvent).not.toBeNull()
    expect(isFreshForwardEvent(4, 5, sourceEvent ?? null, sourceEvent ?? null)).toBe(true)
    expect(isFreshForwardEvent(5, 5, sourceEvent ?? null, sourceEvent ?? null)).toBe(false)
    expect(isFreshForwardEvent(5, 4, sourceEvent ?? null, sourceEvent ?? null)).toBe(false)
    expect(isFreshForwardEvent(0, 0, null, sourceEvent ?? null)).toBe(true)
    const after = {
      ...before,
      units: before.units.filter((unit) => unit.unitId !== victim?.unitId),
      event: {
        ...(sourceEvent as NonNullable<typeof sourceEvent>),
        targetId: victim?.unitId ?? null,
        deathId: victim?.unitId ?? null,
      },
    }
    expect(transitionFor(after.event, true, true, { transitionMs: 500 }, false).animate).toBe(true)
    expect(transitionFor(after.event, true, true, { snap: true }, false).animate).toBe(false)
    expect(transitionFor(after.event, false, true, { transitionMs: 500 }, false).animate).toBe(
      false,
    )
    expect(transitionFor(after.event, true, true, { transitionMs: 500 }, true).animate).toBe(false)
    const snapshot = deathSnapshotFor(before, after)
    expect(snapshot?.unitId).toBe(after.event.deathId)
    expect(eventTargetPositionFor(after.event, after, after, snapshot)).toEqual(victim?.position)
    expect(shouldRebuildBattlefield(null, after, false, false)).toBe(true)
    expect(shouldRebuildBattlefield(after.battlefieldKey, after, false, false)).toBe(false)
    expect(shouldRebuildBattlefield(after.battlefieldKey, after, false, true)).toBe(true)
    expect(shouldRebuildBattlefield(after.battlefieldKey, after, true, true)).toBe(false)
  })

  it('keeps both sides and the actual deltas in simultaneous capture cues', () => {
    const scoredScene = armyStates
      .map((state) => computeScene(state))
      .find(
        (scene) =>
          scene.event !== null && scene.event.redCapture !== 0 && scene.event.blueCapture !== 0,
      )
    if (scoredScene?.event === null || scoredScene?.event === undefined) {
      throw new Error('The army fixture needs a simultaneous capture event')
    }
    const cues = captureCuesFor(scoredScene, scoredScene.event)
    expect(cues.map((cue) => [cue.side, cue.delta])).toEqual([
      ['red', scoredScene.event.redCapture],
      ['blue', scoredScene.event.blueCapture],
    ])
    expect(cues[0]?.position).not.toEqual(cues[1]?.position)
  })

  it('keeps every event cue readable when reduced motion snaps the frame', () => {
    const event = {
      actorId: 'red_archer_0',
      from: { x: 0, y: 0 },
      to: { x: 10, y: 10 },
      targetId: 'blue_footman_0',
      damage: 3,
      automatic: false,
      deathId: null,
      redCapture: 1,
      blueCapture: 0,
    }
    expect(reducedMotionCuesFor(event)).toEqual({
      attackThread: true,
      damageNumeral: true,
      captureNumeral: true,
      flash: false,
    })
  })
})

describe('Crane Reach generated fixture legality', () => {
  it('covers the live-only opening and every actionable skirmish frame', () => {
    verifyLegalityFixture(
      'crane-reach-skirmish-recording.jsonl',
      skirmishFixture,
      skirmishLegalityRaw,
      4,
    )
  })

  it('covers the live-only opening and every actionable army frame', () => {
    verifyLegalityFixture('crane-reach-army-recording.jsonl', armyFixture, armyLegalityRaw, 21)
  })
})
