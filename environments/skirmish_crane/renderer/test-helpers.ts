/**
 * Fixture loading and legality decoding shared by the Crane Reach renderer test files. Test-only:
 * nothing under `renderer/` outside a `.test.ts` file imports this.
 */
import type { StepState } from '@game-sandbox/schema'
import { expect } from 'vitest'

import armyLegalityRaw from '../../../frontend/test/fixtures/crane-reach-army-legality.json?raw'
import armyFixture from '../../../frontend/test/fixtures/crane-reach-army-recording.jsonl?raw'
import skirmishLegalityRaw from '../../../frontend/test/fixtures/crane-reach-skirmish-legality.json?raw'
import skirmishFixture from '../../../frontend/test/fixtures/crane-reach-skirmish-recording.jsonl?raw'
import { decodePath, MAX_PATH_ID } from './paths.js'
import {
  type CraneReachScene,
  computeScene,
  HEX_DIRECTIONS,
  type SceneConfig,
  type SceneUnit,
} from './scene.js'

export { armyFixture, armyLegalityRaw, skirmishFixture, skirmishLegalityRaw }

export interface LegalityEntry {
  opening?: StepState
  tick?: number
  current_activation: string
  path: string
  target: string
}

export interface LegalityFixture {
  version: number
  recording: string
  entries: LegalityEntry[]
}

export function statesFrom(recording: string): StepState[] {
  return recording
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(1)
    .map((line) => JSON.parse(line) as StepState)
}

export function staticOverlayFrom(recording: string): unknown {
  const line = recording.split('\n').find((candidate) => candidate.trim().length > 0)
  return (JSON.parse(line ?? '{}') as { overlay_static?: unknown }).overlay_static
}

export const skirmishStates = statesFrom(skirmishFixture)
export const armyStates = statesFrom(armyFixture)
export const skirmishStaticOverlay = staticOverlayFrom(skirmishFixture)
export const armyStaticOverlay = staticOverlayFrom(armyFixture)

/** computeScene against the skirmish fixture's static overlay, the pairing every skirmish test wants. */
export function skirmishScene(
  state: StepState,
  config: Omit<SceneConfig, 'staticOverlay'> = {},
): CraneReachScene {
  return computeScene(state, { ...config, staticOverlay: skirmishStaticOverlay })
}

/** computeScene against the army fixture's static overlay, the pairing every army test wants. */
export function armyScene(
  state: StepState,
  config: Omit<SceneConfig, 'staticOverlay'> = {},
): CraneReachScene {
  return computeScene(state, { ...config, staticOverlay: armyStaticOverlay })
}

/** Decode one legality bit vector, asserting its length, its stand-still bit, and its padding. */
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

/** The action values one published mask marks legal. */
export function allowedValues(encoded: string, bitCount: number): Set<number> {
  const bytes = verifyBitVector(encoded, bitCount)
  const allowed = new Set<number>()
  for (let value = 0; value < bitCount; value += 1) {
    const byte = bytes[Math.floor(value / 8)] as number
    if ((byte & (1 << (value % 8))) !== 0) allowed.add(value)
  }
  return allowed
}

/** The states whose overlay carries an activation, which are the frames an order can answer. */
export function actionableStates(states: readonly StepState[]): StepState[] {
  return states.filter((state) => ((state.overlay ?? {}) as Record<string, unknown>).a !== null)
}

/** The states each legality entry describes: the live-only opening, then every actionable frame. */
export function legalityCases(
  recording: string,
  legalityRaw: string,
): { entry: LegalityEntry; state: StepState }[] {
  const legality = JSON.parse(legalityRaw) as LegalityFixture
  const actionable = actionableStates(statesFrom(recording))
  return legality.entries.map((entry, index) => ({
    entry,
    state: (index === 0 ? entry.opening : actionable[index - 1]) as StepState,
  }))
}

/**
 * Walk the decoded directions from the start tile. The id-to-directions decoding now comes from the
 * shared codec, so this applies HEX_DIRECTIONS directly to the decoded ids: it is the one part of the
 * check that still walks independently of the renderer.
 */
function destinationForPath(start: string, path: number[]): string {
  let [q, r] = start.split(',').map(Number) as [number, number]
  for (const direction of path) {
    const [dq, dr] = HEX_DIRECTIONS[direction - 1] as readonly [number, number]
    q += dq
    r += dr
  }
  return `${q},${r}`
}

export function expectedDestinations(entry: LegalityEntry, unit: SceneUnit): Set<string> {
  const destinations = new Set<string>()
  for (const pathId of allowedValues(entry.path, MAX_PATH_ID + 1)) {
    destinations.add(destinationForPath(unit.tileKey, decodePath(pathId)))
  }
  return destinations
}

export function verifyLegalityFixture(
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

  const actionable = actionableStates(states)
  expect(legality.entries).toHaveLength(actionable.length + 1)
  expect(opening?.current_activation).toBe(
    computeScene(opening?.opening as StepState, {
      staticOverlay: header.overlay_static,
    }).activation?.playerId,
  )

  for (const [index, state] of actionable.entries()) {
    const entry = legality.entries[index + 1] as LegalityEntry
    expect(entry).not.toHaveProperty('opening')
    expect(entry.tick).toBe(state.tick)
    expect(entry.current_activation).toBe(
      computeScene(state, { staticOverlay: header.overlay_static }).activation?.playerId,
    )
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
    expectAllowed(verifyBitVector(entry.path, MAX_PATH_ID + 1), action?.path as number)
    expectAllowed(verifyBitVector(entry.target, targetBits), action?.target as number)
  }
}
