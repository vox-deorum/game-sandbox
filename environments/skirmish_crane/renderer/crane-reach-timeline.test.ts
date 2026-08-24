import { describe, expect, it, vi } from 'vitest'

import { CraneReachRenderer } from './index.js'
import type { CraneReachScene, SceneUnit } from './scene.js'
import {
  type EventShape,
  eventActiveTracks,
  eventPhaseAt,
  eventRangeVisibleAt,
  eventScale,
  eventTimelineProgress,
  eventWindows,
  hostEase,
  rangedArcAlpha,
  reactionNumeralAlpha,
  routePositionFor,
  routeTrailFor,
  CRANE_TIMING as T,
} from './timeline.js'

function shape(overrides: Partial<EventShape> = {}): EventShape {
  return { movementTiles: 0, hasTarget: false, hasReaction: false, ...overrides }
}

/** A charge across four tiles into a target that reacts: the schedule's longest ordinary shape. */
const CHARGE: EventShape = { movementTiles: 4, hasTarget: true, hasReaction: true }

describe('Crane Reach event windows', () => {
  it('installs the resolved frame before its hold without advancing perspective', () => {
    const schedule = eventWindows(shape())
    const resolved = { battlefieldKey: 'resolved' } as CraneReachScene
    type EventHarness = {
      eventSchedule: typeof schedule
      eventAnimating: boolean
      eventElapsedMs: number
      settleDurationMs: number
      settleRemainingMs: number
      currentScene: CraneReachScene
      advanceEvent(dtMs: number): boolean
      updateEventPhaseProbe: ReturnType<typeof vi.fn>
      reconcilePresentedScene: ReturnType<typeof vi.fn>
      reconcileEvent: ReturnType<typeof vi.fn>
      completeEvent: ReturnType<typeof vi.fn>
    }
    const renderer = Object.create(CraneReachRenderer.prototype) as EventHarness
    Object.assign(renderer, {
      eventSchedule: schedule,
      eventAnimating: true,
      eventElapsedMs: schedule.durationMs - 1,
      settleDurationMs: T.watchSettleMs,
      settleRemainingMs: 0,
      currentScene: resolved,
      updateEventPhaseProbe: vi.fn(),
      reconcilePresentedScene: vi.fn(),
      reconcileEvent: vi.fn(),
      completeEvent: vi.fn(),
    })

    expect(renderer.advanceEvent(1)).toBe(true)
    expect(renderer.settleRemainingMs).toBe(T.watchSettleMs)
    expect(renderer.updateEventPhaseProbe).toHaveBeenCalledOnce()
    expect(renderer.reconcilePresentedScene).toHaveBeenCalledWith(resolved, true, true)
    expect(renderer.reconcileEvent).toHaveBeenCalledOnce()
    expect(renderer.completeEvent).not.toHaveBeenCalled()
  })

  it('keeps the completed actor range during a move-only settled frame', () => {
    const actor = { unitId: 'red_actor' } as SceneUnit
    const next = { unitId: 'blue_next' } as SceneUnit
    const resolved = {
      units: [actor, next],
      activation: next,
    } as unknown as CraneReachScene
    type RangeHarness = {
      event: { actorId: string }
      perspective: null
      inspectedUnit: ReturnType<typeof vi.fn>
      eventRangeVisible: ReturnType<typeof vi.fn>
      drawUnitRange: ReturnType<typeof vi.fn>
      clearRange: ReturnType<typeof vi.fn>
      reconcileEventRange(scene: CraneReachScene): void
    }
    const renderer = Object.create(CraneReachRenderer.prototype) as RangeHarness
    Object.assign(renderer, {
      event: { actorId: actor.unitId },
      perspective: null,
      inspectedUnit: vi.fn(() => null),
      eventRangeVisible: vi.fn(() => true),
      drawUnitRange: vi.fn(),
      clearRange: vi.fn(),
    })

    renderer.reconcileEventRange(resolved)

    expect(renderer.drawUnitRange).toHaveBeenCalledWith(resolved, actor, false)
    expect(renderer.clearRange).not.toHaveBeenCalled()
  })

  it('gives every event an activation, and a no-op turn nothing else', () => {
    const windows = eventWindows(shape())
    expect(windows.activation.startMs).toBe(0)
    expect(windows.movement).toBeNull()
    expect(windows.attack).toBeNull()
    expect(windows.reaction).toBeNull()
    expect(windows.durationMs).toBe(windows.activation.endMs)
  })

  it('hangs each beat off the end of the one before it', () => {
    const windows = eventWindows(CHARGE)
    expect(windows.movement?.startMs).toBe(windows.activation.endMs)
    expect(windows.attack?.startMs).toBe(windows.movement?.endMs)
    // The reaction joins partway into the attack rather than waiting for it.
    expect(windows.reaction?.startMs).toBeGreaterThan(windows.attack?.startMs ?? 0)
    expect(windows.reaction?.startMs).toBeLessThan(windows.attack?.endMs ?? 0)
    expect(windows.durationMs).toBe(
      Math.max(windows.attack?.endMs ?? 0, windows.reaction?.endMs ?? 0),
    )
  })

  it('makes a longer route take longer', () => {
    const short = eventWindows(shape({ movementTiles: 1 }))
    const long = eventWindows(shape({ movementTiles: 4 }))
    expect(long.movement?.endMs).toBeGreaterThan(short.movement?.endMs ?? 0)
    expect(long.durationMs).toBeGreaterThan(short.durationMs)
  })

  it('starts an attack where movement ends, whether or not the actor moved', () => {
    for (const tiles of [0, 4]) {
      const windows = eventWindows(shape({ movementTiles: tiles, hasTarget: true }))
      expect(windows.attack?.startMs).toBe(windows.movement?.endMs ?? windows.activation.endMs)
      // Nothing was hurt and no ground changed hands, so the attack itself is the last beat.
      expect(windows.reaction).toBeNull()
      expect(windows.durationMs).toBe(windows.attack?.endMs)
    }
  })

  it('opens a capture-only reaction the moment movement ends, with no attack to delay it', () => {
    const windows = eventWindows(shape({ movementTiles: 2, hasReaction: true }))
    expect(windows.attack).toBeNull()
    expect(windows.reaction?.startMs).toBe(windows.movement?.endMs)
    expect(windows.durationMs).toBe(windows.reaction?.endMs)
  })

  it('scales the whole schedule in proportion, and treats an omitted scale as natural', () => {
    const natural = eventWindows(CHARGE)
    expect(eventWindows(CHARGE, 1)).toEqual(natural)
    expect(eventWindows(CHARGE, 0).durationMs).toBe(0)
    for (const scale of [0.5, 2]) {
      const scaled = eventWindows(CHARGE, scale)
      expect(scaled.durationMs).toBe(natural.durationMs * scale)
      expect(scaled.reaction?.startMs).toBe((natural.reaction?.startMs ?? 0) * scale)
    }
  })

  it('normalizes a host scale, treating anything unusable as natural timing', () => {
    expect(eventScale()).toBe(1)
    expect(eventScale({})).toBe(1)
    expect(eventScale({ transitionScale: 1 })).toBe(1)
    expect(eventScale({ transitionScale: -1 })).toBe(1)
    expect(eventScale({ transitionScale: Number.NaN })).toBe(1)
    expect(eventScale({ transitionScale: Number.POSITIVE_INFINITY })).toBe(1)
    expect(eventScale({ transitionScale: Number.NEGATIVE_INFINITY })).toBe(1)
    expect(eventScale({ transitionScale: 0 })).toBe(0)
    expect(eventScale({ transitionScale: 0.5 })).toBe(0.5)
    expect(eventScale({ transitionScale: 2 })).toBe(2)
  })
})

describe('Crane Reach event progress', () => {
  it('runs each track over its own window and clamps outside it', () => {
    const windows = eventWindows(CHARGE)
    expect(eventTimelineProgress(0, windows)).toEqual({ movement: 0, attack: 0, reaction: 0 })
    expect(eventTimelineProgress(windows.durationMs, windows)).toEqual({
      movement: 1,
      attack: 1,
      reaction: 1,
    })
    // Movement is finished and the reaction has not begun while the attack is between the two.
    const midAttack = eventTimelineProgress(windows.reaction?.startMs ?? 0, windows)
    expect(midAttack.movement).toBe(1)
    expect(midAttack.attack).toBeGreaterThan(0)
    expect(midAttack.attack).toBeLessThan(1)
    expect(midAttack.reaction).toBe(0)
  })

  it('leaves an absent track at zero throughout', () => {
    const captureOnly = eventWindows(shape({ movementTiles: 2, hasReaction: true }))
    const midReaction = eventTimelineProgress(
      (captureOnly.reaction?.startMs ?? 0) + T.reactionMs / 2,
      captureOnly,
    )
    expect(midReaction).toEqual({ movement: 1, attack: 0, reaction: 0.5 })
  })

  it('holds a damage or capture numeral still and legible before it lifts away', () => {
    const windows = eventWindows(CHARGE)
    // The same curve gives the numeral its opacity and, inverted, its rise, so a full-strength
    // numeral is also a stationary one.
    const alphaAt = (elapsedMs: number): number =>
      reactionNumeralAlpha(eventTimelineProgress(elapsedMs, windows).reaction)
    const { startMs, endMs } = windows.reaction ?? { startMs: 0, endMs: 0 }
    expect(alphaAt(startMs)).toBe(1)
    // Still fully readable and still in place halfway through the beat, rather than already drifting.
    expect(alphaAt((startMs + endMs) / 2)).toBe(1)
    expect(alphaAt(endMs)).toBe(0)
    // The rise and the fade only run over the tail.
    const nearEnd = alphaAt(startMs + (endMs - startMs) * 0.9)
    expect(nearEnd).toBeGreaterThan(0)
    expect(nearEnd).toBeLessThan(1)
  })

  it('fades the ranged arc across the reaction rather than on impact', () => {
    const windows = eventWindows(CHARGE)
    const alphaAt = (elapsedMs: number): number =>
      rangedArcAlpha(eventTimelineProgress(elapsedMs, windows).attack)
    const reactionStart = windows.reaction?.startMs ?? 0
    const attackEnd = windows.attack?.endMs ?? 0
    expect(alphaAt(windows.attack?.startMs ?? 0)).toBe(1)
    // Still mostly there as the target starts reacting, so the shot and its impact are both readable.
    expect(alphaAt(reactionStart)).toBeCloseTo(1 - T.reactionOffsetMs / T.attackMs, 10)
    expect(alphaAt(reactionStart)).toBeGreaterThan(0.5)
    expect(alphaAt((reactionStart + attackEnd) / 2)).toBeGreaterThan(0)
    expect(alphaAt(attackEnd)).toBe(0)
  })
})

describe('Crane Reach event phases', () => {
  it('names the latest beat to have started, and reports the beats running at once', () => {
    const windows = eventWindows(CHARGE)
    const attackStart = windows.attack?.startMs ?? 0
    const reactionStart = windows.reaction?.startMs ?? 0
    expect(eventPhaseAt(0, windows)).toBe('activation')
    expect(eventPhaseAt(windows.activation.endMs, windows)).toBe('movement')
    expect(eventPhaseAt(attackStart, windows)).toBe('attack')
    expect(eventPhaseAt(reactionStart, windows)).toBe('reaction')
    expect(eventPhaseAt(windows.durationMs, windows)).toBe('idle')
    expect(eventPhaseAt(attackStart, windows, false)).toBe('idle')

    expect(eventActiveTracks(0, windows)).toEqual(['activation'])
    expect(eventActiveTracks(attackStart, windows)).toEqual(['attack'])
    // The overlap the whole schedule exists for: the blow is still landing as the target reacts.
    expect(eventActiveTracks(reactionStart, windows)).toEqual(['attack', 'reaction'])
  })

  it('holds the acting range through activation and movement, then clears it on contact', () => {
    const charge = eventWindows(CHARGE)
    const contact = charge.attack?.startMs ?? 0
    expect(eventRangeVisibleAt(0, charge)).toBe(true)
    expect(eventRangeVisibleAt(contact - 1, charge)).toBe(true)
    expect(eventRangeVisibleAt(contact, charge)).toBe(false)

    // A capture with nothing struck clears it on the reaction instead, at the same point.
    const captureOnly = eventWindows(shape({ movementTiles: 2, hasReaction: true }))
    const taken = captureOnly.reaction?.startMs ?? 0
    expect(eventRangeVisibleAt(taken - 1, captureOnly)).toBe(true)
    expect(eventRangeVisibleAt(taken, captureOnly)).toBe(false)

    // A plain move takes no ground and hits nothing, so its range stays up for the whole event.
    const plainMove = eventWindows(shape({ movementTiles: 3 }))
    expect(eventRangeVisibleAt(plainMove.durationMs, plainMove)).toBe(true)
  })
})

describe('Crane Reach route walking', () => {
  it('eases the host curve and walks a route one tile at a time', () => {
    expect(hostEase(0)).toBe(0)
    expect(hostEase(0.2)).toBeCloseTo(0.5, 4)
    expect(hostEase(1)).toBe(1)

    const route = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 0, y: 20 },
    ]
    expect(routePositionFor(route, 0.25)).toEqual({ x: 10, y: 0 })
    expect(routePositionFor(route, 0.5)).toEqual({ x: 10, y: 10 })
    expect(routePositionFor(route, 0.75)).toEqual({ x: 0, y: 10 })
    expect(routePositionFor(route, 1)).toEqual({ x: 0, y: 20 })
    expect(routeTrailFor(route, 0.5)).toEqual(route.slice(0, 3))
  })
})
