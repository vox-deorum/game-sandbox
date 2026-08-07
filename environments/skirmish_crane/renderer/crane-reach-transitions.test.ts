import type { StepState } from '@game-sandbox/schema'
import { describe, expect, it } from 'vitest'

import { computeScene } from './scene.js'
import { armyStates } from './test-helpers.js'
import type { SceneEvent } from './scene.js'
import {
  captureCueSceneFor,
  captureCuesFor,
  deathSnapshotFor,
  eventHasReaction,
  eventShapeFor,
  eventTargetPositionFor,
  isFreshForwardEvent,
  shouldAnimateEvent,
  shouldRebuildBattlefield,
  transitionSceneFor,
} from './transitions.js'

/** A plain move: nothing struck, nobody hurt, no ground taken. */
const QUIET: SceneEvent = {
  actorId: 'red-0',
  from: { x: 0, y: 0 },
  to: { x: 10, y: 0 },
  route: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
  ],
  movementTiles: 1,
  targetId: null,
  damage: 0,
  automatic: false,
  deathId: null,
  redCapture: 0,
  blueCapture: 0,
}

describe('Crane Reach event transitions', () => {
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
    expect(shouldAnimateEvent(after.event, true, true, { transitionScale: 0.5 })).toBe(true)
    expect(shouldAnimateEvent(after.event, true, true, undefined)).toBe(true)
    expect(shouldAnimateEvent(after.event, true, true, { snap: true })).toBe(false)
    // A zero scale means "complete immediately", so it stills the event exactly as a snap does.
    expect(shouldAnimateEvent(after.event, true, true, { transitionScale: 0 })).toBe(false)
    expect(shouldAnimateEvent(after.event, false, true, { transitionScale: 0.5 })).toBe(false)
    expect(shouldAnimateEvent(after.event, true, false, { transitionScale: 0.5 })).toBe(false)
    expect(shouldAnimateEvent(null, true, true, undefined)).toBe(false)
    const snapshot = deathSnapshotFor(before, after)
    expect(snapshot?.unitId).toBe(after.event.deathId)
    expect(eventTargetPositionFor(after.event, after, after, snapshot)).toEqual(victim?.position)
    expect(shouldRebuildBattlefield(null, after, false, false)).toBe(true)
    expect(shouldRebuildBattlefield(after.battlefieldKey, after, false, false)).toBe(false)
    expect(shouldRebuildBattlefield(after.battlefieldKey, after, false, true)).toBe(true)
    expect(shouldRebuildBattlefield(after.battlefieldKey, after, true, true)).toBe(false)
    expect(transitionSceneFor(before, after, true)).toBe(before)
    expect(transitionSceneFor(before, after, false)).toBe(after)
    expect(transitionSceneFor(null, after, true)).toBe(after)
  })

  it('reacts to a landed blow, a death, or a capture, but not to a bare miss', () => {
    expect(eventHasReaction(QUIET)).toBe(false)
    // A target that takes nothing and loses nothing gives the attack no reaction to overlap with.
    expect(eventHasReaction({ ...QUIET, targetId: 'blue-1' })).toBe(false)
    expect(eventHasReaction({ ...QUIET, targetId: 'blue-1', damage: 2 })).toBe(true)
    expect(eventHasReaction({ ...QUIET, targetId: 'blue-1', deathId: 'blue-1' })).toBe(true)
    expect(eventHasReaction({ ...QUIET, redCapture: 1 })).toBe(true)
    expect(eventHasReaction({ ...QUIET, blueCapture: -1 })).toBe(true)
  })

  it('reads the schedule shape off the event', () => {
    expect(eventShapeFor(QUIET)).toEqual({
      movementTiles: 1,
      hasTarget: false,
      hasReaction: false,
    })
    // Damage and a death that follows it share one reaction, so the shape is the same either way.
    const wounded = { ...QUIET, movementTiles: 3, targetId: 'blue-1', damage: 2 }
    expect(eventShapeFor(wounded)).toEqual({
      movementTiles: 3,
      hasTarget: true,
      hasReaction: true,
    })
    expect(eventShapeFor({ ...wounded, deathId: 'blue-1' })).toEqual(eventShapeFor(wounded))
    // A capture with nothing struck reacts without an attack to hang off.
    expect(eventShapeFor({ ...QUIET, blueCapture: 2 })).toEqual({
      movementTiles: 1,
      hasTarget: false,
      hasReaction: true,
    })
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
    const prior = { ...scoredScene, units: [] }
    expect(captureCueSceneFor(scoredScene, prior)).toBe(scoredScene)
    expect(captureCueSceneFor(null, prior)).toBe(prior)
  })
})
