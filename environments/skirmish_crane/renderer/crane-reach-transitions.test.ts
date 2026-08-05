import type { StepState } from '@game-sandbox/schema'
import { describe, expect, it } from 'vitest'

import { computeScene } from './scene.js'
import { armyStates } from './test-helpers.js'
import {
  captureCueSceneFor,
  captureCuesFor,
  deathSnapshotFor,
  eventTargetPositionFor,
  isFreshForwardEvent,
  shouldDeferEventUpdate,
  shouldRebuildBattlefield,
  transitionFor,
  transitionSceneFor,
} from './transitions.js'

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
    expect(transitionFor(after.event, true, true, { transitionMs: 500 }).animate).toBe(true)
    expect(transitionFor(after.event, true, true, { snap: true }).animate).toBe(false)
    expect(transitionFor(after.event, false, true, { transitionMs: 500 }).animate).toBe(false)
    expect(transitionFor(after.event, true, false, { transitionMs: 500 }).animate).toBe(false)
    const snapshot = deathSnapshotFor(before, after)
    expect(snapshot?.unitId).toBe(after.event.deathId)
    expect(eventTargetPositionFor(after.event, after, after, snapshot)).toEqual(victim?.position)
    expect(shouldRebuildBattlefield(null, after, false, false)).toBe(true)
    expect(shouldRebuildBattlefield(after.battlefieldKey, after, false, false)).toBe(false)
    expect(shouldRebuildBattlefield(after.battlefieldKey, after, false, true)).toBe(true)
    expect(shouldRebuildBattlefield(after.battlefieldKey, after, true, true)).toBe(false)
    expect(transitionSceneFor(before, after, true, 0.999)).toBe(before)
    expect(transitionSceneFor(before, after, true, 1)).toBe(after)
    expect(transitionSceneFor(before, after, false, 0)).toBe(after)
  })

  it('paints a completed event before beginning the next forward event', () => {
    // A fresh state arriving over an unfinished or already-deferred event is deferred, so the
    // completed event paints its final frame before the next event installs at progress zero.
    expect(shouldDeferEventUpdate(true, true, false, false)).toBe(true)
    expect(shouldDeferEventUpdate(false, true, false, true)).toBe(true)

    // Snap frames always replace the scene immediately, and so does a fresh state over a settled one.
    expect(shouldDeferEventUpdate(true, true, true, false)).toBe(false)
    expect(shouldDeferEventUpdate(false, false, false, true)).toBe(false)
    expect(shouldDeferEventUpdate(false, true, false, false)).toBe(false)
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
