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
import { computeScene, type SceneUnit } from './scene.js'

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

export const skirmishStates = statesFrom(skirmishFixture)
export const armyStates = statesFrom(armyFixture)

/** Decode one legality bit vector, asserting its length, its stand-still bit, and its padding. */
export function verifyBitVector(encoded: string, bitCount: number): Uint8Array {
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

export function expectAllowed(bytes: Uint8Array, action: number): void {
  const byte = bytes[Math.floor(action / 8)] as number
  expect(byte & (1 << (action % 8))).not.toBe(0)
}

/** Expand a wire path id back into its direction sequence, independently of the renderer. */
export function pathForId(pathId: number): number[] {
  if (pathId === 0) return []
  let remaining = pathId - 1
  let length = 1
  while (remaining >= 6 ** length) {
    remaining -= 6 ** length
    length += 1
  }
  const path: number[] = []
  for (let power = length - 1; power >= 0; power -= 1) {
    const digit = Math.floor(remaining / 6 ** power)
    remaining %= 6 ** power
    path.push(digit + 1)
  }
  return path
}

export function destinationForPath(start: string, path: number[]): string {
  const directions = [
    [1, -1],
    [1, 0],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [0, -1],
  ] as const
  let [q, r] = start.split(',').map(Number) as [number, number]
  for (const direction of path) {
    const [dq, dr] = directions[direction - 1] as (typeof directions)[number]
    q += dq
    r += dr
  }
  return `${q},${r}`
}

export function expectedDestinations(entry: LegalityEntry, unit: SceneUnit): Set<string> {
  const paths = verifyBitVector(entry.path, 1555)
  const destinations = new Set<string>()
  for (let pathId = 0; pathId <= 1554; pathId += 1) {
    const byte = paths[Math.floor(pathId / 8)] as number
    if ((byte & (1 << (pathId % 8))) !== 0)
      destinations.add(destinationForPath(unit.tileKey, pathForId(pathId)))
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
