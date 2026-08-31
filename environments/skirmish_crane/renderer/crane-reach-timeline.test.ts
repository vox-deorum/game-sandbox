import { describe, expect, it, vi } from 'vitest'
import { Container } from 'pixi.js'

import { FOG_CROSSFADE_MS } from './composition.js'
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
      eventContacted: boolean
      currentScene: CraneReachScene
      advanceEvent(dtMs: number): boolean
      installEventContact: ReturnType<typeof vi.fn>
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
      eventContacted: true,
      currentScene: resolved,
      installEventContact: vi.fn(),
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
    expect(renderer.installEventContact).not.toHaveBeenCalled()
  })

  it('changes perspective at contact once, before drawing the first attack frame', () => {
    const schedule = eventWindows(shape({ movementTiles: 2, hasTarget: true }))
    const calls: string[] = []
    type ContactHarness = {
      eventSchedule: typeof schedule
      eventAnimating: boolean
      eventElapsedMs: number
      eventContacted: boolean
      settleDurationMs: number
      settleRemainingMs: number
      presentedScene: null
      advanceEvent(dtMs: number): boolean
      installEventContact(): void
      updateEventPhaseProbe(): void
      reconcileEvent(): void
      completeEvent(): void
    }
    const renderer = Object.create(CraneReachRenderer.prototype) as ContactHarness
    Object.assign(renderer, {
      eventSchedule: schedule,
      eventAnimating: true,
      eventElapsedMs: (schedule.attack?.startMs ?? 0) - 1,
      eventContacted: false,
      settleDurationMs: 0,
      settleRemainingMs: 0,
      presentedScene: null,
      installEventContact: () => {
        renderer.eventContacted = true
        calls.push('contact')
      },
      updateEventPhaseProbe: () => calls.push('phase'),
      reconcileEvent: () => calls.push('event'),
      completeEvent: () => calls.push('complete'),
    })

    expect(renderer.advanceEvent(1)).toBe(true)
    expect(calls).toEqual(['contact', 'phase', 'event'])
    expect(renderer.advanceEvent(1)).toBe(true)
    expect(calls.filter((call) => call === 'contact')).toHaveLength(1)
  })

  it('processes contact at the end of stationary, move-only, and capture-only events', () => {
    const cases = [
      shape({ hasTarget: true }),
      shape({ movementTiles: 2 }),
      shape({ movementTiles: 2, hasReaction: true }),
      shape(),
    ]
    for (const eventShape of cases) {
      const schedule = eventWindows(eventShape)
      type BoundaryHarness = {
        eventSchedule: typeof schedule
        eventAnimating: boolean
        eventElapsedMs: number
        eventContacted: boolean
        settleDurationMs: number
        settleRemainingMs: number
        presentedScene: null
        advanceEvent(dtMs: number): boolean
        installEventContact: ReturnType<typeof vi.fn>
        completeEvent: ReturnType<typeof vi.fn>
        updateEventPhaseProbe: ReturnType<typeof vi.fn>
        reconcileEvent: ReturnType<typeof vi.fn>
      }
      const renderer = Object.create(CraneReachRenderer.prototype) as BoundaryHarness
      const installEventContact = vi.fn(() => {
        renderer.eventContacted = true
      })
      Object.assign(renderer, {
        eventSchedule: schedule,
        eventAnimating: true,
        eventElapsedMs:
          (schedule.movement?.endMs ?? schedule.activation.endMs) - 1,
        eventContacted: false,
        settleDurationMs: 0,
        settleRemainingMs: 0,
        presentedScene: null,
        installEventContact,
        completeEvent: vi.fn(),
        updateEventPhaseProbe: vi.fn(),
        reconcileEvent: vi.fn(),
      })

      renderer.advanceEvent(1)

      expect(installEventContact).toHaveBeenCalledOnce()
      if ((schedule.movement?.endMs ?? schedule.activation.endMs) === schedule.durationMs) {
        expect(renderer.completeEvent).toHaveBeenCalledOnce()
      }
    }
  })

  it('clears the outgoing veil immediately when the resolving view reaches contact', () => {
    const fogLayer = new Container()
    const fadingFogLayer = new Container()
    fogLayer.addChild(new Container())
    fadingFogLayer.addChild(new Container())
    const scene = { tiles: [], hud: { terminal: null } } as unknown as CraneReachScene
    type FogHarness = {
      perspective: null
      fogLayer: Container
      fadingFogLayer: Container
      fogElapsedMs: number
      sprite: () => null
      ctx: { container: HTMLElement }
      applyFogCrossfade(): void
      installFog(scene: CraneReachScene, perspective: null, crossfade: boolean): void
    }
    const renderer = Object.create(CraneReachRenderer.prototype) as FogHarness
    Object.assign(renderer, {
      perspective: null,
      fogLayer,
      fadingFogLayer,
      fogElapsedMs: 0,
      sprite: () => null,
      ctx: { container: document.createElement('div') },
    })

    renderer.installFog(scene, null, false)

    expect(renderer.fadingFogLayer.children).toHaveLength(0)
    expect(renderer.fogElapsedMs).toBe(FOG_CROSSFADE_MS)
    expect(renderer.fogLayer.alpha).toBe(1)
    expect(renderer.fadingFogLayer.alpha).toBe(0)
  })

  it('refreshes retained event units after installing the final-tile fog', () => {
    const arriving = {
      hud: { terminal: null },
      units: [],
      tiles: [],
      visibility: new Map(),
    } as unknown as CraneReachScene
    const retained = { battlefieldKey: 'before-contact' } as CraneReachScene
    const calls: string[] = []
    type ContactInstallHarness = {
      currentScene: CraneReachScene
      previousScene: CraneReachScene
      event: { targetId: string; deathId: string }
      perspective: { observers: string[]; units: Set<string>; tiles: Set<string> }
      eventContacted: boolean
      installEventContact(): void
      installFog: ReturnType<typeof vi.fn>
      updateInspectionProbe: ReturnType<typeof vi.fn>
      reconcileUnits: ReturnType<typeof vi.fn>
      reconcileEventRange: ReturnType<typeof vi.fn>
      reconcileInspection: ReturnType<typeof vi.fn>
    }
    const renderer = Object.create(CraneReachRenderer.prototype) as ContactInstallHarness
    Object.assign(renderer, {
      currentScene: arriving,
      previousScene: retained,
      event: { targetId: 'defeated', deathId: 'defeated' },
      perspective: { observers: [], units: new Set(), tiles: new Set() },
      eventContacted: false,
      installFog: vi.fn(() => calls.push('fog')),
      updateInspectionProbe: vi.fn(() => calls.push('probe')),
      reconcileUnits: vi.fn(() => calls.push('units')),
      reconcileEventRange: vi.fn(() => calls.push('range')),
      reconcileInspection: vi.fn(() => calls.push('inspection')),
    })

    renderer.installEventContact()

    expect(renderer.eventContacted).toBe(true)
    expect(renderer.installFog).toHaveBeenCalledWith(
      arriving,
      expect.objectContaining({ units: new Set(['defeated']) }),
      false,
    )
    expect(renderer.updateInspectionProbe).toHaveBeenCalledWith(retained)
    expect(renderer.reconcileUnits).toHaveBeenCalledWith(retained)
    expect(renderer.reconcileEventRange).toHaveBeenCalledWith(retained)
    expect(renderer.reconcileInspection).toHaveBeenCalledWith(retained)
    expect(calls).toEqual(['fog', 'units', 'probe', 'range', 'inspection'])
  })

  it('keeps the final-tile fog on refresh through reaction and its settled hold', () => {
    const schedule = eventWindows(shape({ hasReaction: true }))
    const prior = { battlefieldKey: 'before-contact' } as CraneReachScene
    const arriving = {
      hud: { terminal: null },
      units: [],
      tiles: [],
      visibility: new Map(),
    } as unknown as CraneReachScene
    const startPerspective = { observers: [], units: new Set<string>(), tiles: new Set<string>() }
    const fogCalls: Array<{ scene: CraneReachScene; crossfade: boolean }> = []
    type LifecycleHarness = {
      eventSchedule: typeof schedule
      eventAnimating: boolean
      eventElapsedMs: number
      eventContacted: boolean
      settleDurationMs: number
      settleRemainingMs: number
      event: { targetId: null; deathId: null }
      currentScene: CraneReachScene
      previousScene: CraneReachScene
      presentedScene: CraneReachScene
      perspective: typeof startPerspective
      advanceEvent(dtMs: number): boolean
      refreshVisual(): void
      completeEvent(): void
      installFog: ReturnType<typeof vi.fn>
      ensureBattlefield: ReturnType<typeof vi.fn>
      updateInspectionProbe: ReturnType<typeof vi.fn>
      reconcileUnits: ReturnType<typeof vi.fn>
      reconcileEventRange: ReturnType<typeof vi.fn>
      reconcileInspection: ReturnType<typeof vi.fn>
      reconcilePresentedScene: ReturnType<typeof vi.fn>
      reconcileEvent: ReturnType<typeof vi.fn>
      updateEventPhaseProbe: ReturnType<typeof vi.fn>
      reconcileEventActivation: ReturnType<typeof vi.fn>
      inspectedUnit: ReturnType<typeof vi.fn>
      eventRangeVisible: ReturnType<typeof vi.fn>
      clearRange: ReturnType<typeof vi.fn>
      followActivation: ReturnType<typeof vi.fn>
    }
    const renderer = Object.create(CraneReachRenderer.prototype) as LifecycleHarness
    const installFog = vi.fn((scene: CraneReachScene, perspective: typeof startPerspective) => {
      fogCalls.push({ scene, crossfade: false })
      renderer.perspective = perspective
    })
    const reconcilePresentedScene = vi.fn((scene: CraneReachScene) => {
      renderer.presentedScene = scene
    })
    Object.assign(renderer, {
      eventSchedule: schedule,
      eventAnimating: true,
      eventElapsedMs: schedule.activation.endMs - 1,
      eventContacted: false,
      settleDurationMs: T.watchSettleMs,
      settleRemainingMs: 0,
      event: { targetId: null, deathId: null },
      currentScene: arriving,
      previousScene: prior,
      presentedScene: prior,
      perspective: startPerspective,
      installFog,
      ensureBattlefield: vi.fn(),
      updateInspectionProbe: vi.fn(),
      reconcileUnits: vi.fn(),
      reconcileEventRange: vi.fn(),
      reconcileInspection: vi.fn(),
      reconcilePresentedScene,
      reconcileEvent: vi.fn(),
      updateEventPhaseProbe: vi.fn(),
      reconcileEventActivation: vi.fn(),
      inspectedUnit: vi.fn(() => null),
      eventRangeVisible: vi.fn(() => false),
      clearRange: vi.fn(),
      followActivation: vi.fn(),
    })

    // A stationary capture reaches contact when its activation cue ends, before its reaction.
    expect(renderer.advanceEvent(1)).toBe(true)
    expect(renderer.eventContacted).toBe(true)
    expect(fogCalls).toEqual([{ scene: arriving, crossfade: false }])
    expect(renderer.reconcileUnits).toHaveBeenCalledWith(prior)

    renderer.refreshVisual()
    expect(fogCalls).toEqual([
      { scene: arriving, crossfade: false },
      { scene: arriving, crossfade: false },
    ])
    expect(renderer.reconcilePresentedScene).toHaveBeenLastCalledWith(prior, true, true)

    renderer.advanceEvent(schedule.durationMs - renderer.eventElapsedMs)
    expect(renderer.settleRemainingMs).toBe(T.watchSettleMs)
    expect(renderer.reconcilePresentedScene).toHaveBeenLastCalledWith(arriving, true, true)

    renderer.refreshVisual()
    expect(fogCalls).toHaveLength(3)
    expect(fogCalls[2]).toEqual({ scene: arriving, crossfade: false })
    expect(renderer.reconcilePresentedScene).toHaveBeenLastCalledWith(arriving, true, true)

    renderer.advanceEvent(T.watchSettleMs)
    expect(renderer.eventAnimating).toBe(false)
    expect(renderer.reconcilePresentedScene).toHaveBeenLastCalledWith(arriving, false)
    expect(renderer.followActivation).toHaveBeenCalledOnce()
  })

  it('uses ordinary fog reconciliation before contact and after event completion', () => {
    const prior = { battlefieldKey: 'before-contact' } as CraneReachScene
    const arriving = { battlefieldKey: 'after-contact' } as CraneReachScene
    type RefreshHarness = {
      eventAnimating: boolean
      eventContacted: boolean
      presentedScene: CraneReachScene
      currentScene: CraneReachScene
      refreshVisual(): void
      ensureBattlefield: ReturnType<typeof vi.fn>
      installFog: ReturnType<typeof vi.fn>
      reconcilePresentedScene: ReturnType<typeof vi.fn>
      reconcileEvent: ReturnType<typeof vi.fn>
    }
    const renderer = Object.create(CraneReachRenderer.prototype) as RefreshHarness
    Object.assign(renderer, {
      eventAnimating: true,
      eventContacted: false,
      presentedScene: prior,
      currentScene: arriving,
      ensureBattlefield: vi.fn(),
      installFog: vi.fn(),
      reconcilePresentedScene: vi.fn(),
      reconcileEvent: vi.fn(),
    })

    renderer.refreshVisual()
    expect(renderer.installFog).not.toHaveBeenCalled()
    expect(renderer.reconcilePresentedScene).toHaveBeenCalledWith(prior, true, false)

    renderer.eventAnimating = false
    renderer.eventContacted = true
    renderer.refreshVisual()
    expect(renderer.installFog).not.toHaveBeenCalled()
    expect(renderer.reconcilePresentedScene).toHaveBeenLastCalledWith(prior, false, false)
  })

  it('redraws a terminal final scene without restoring the starting fog', () => {
    const prior = { battlefieldKey: 'before-terminal' } as CraneReachScene
    const terminal = { hud: { terminal: 'red' } } as unknown as CraneReachScene
    type TerminalRefreshHarness = {
      eventAnimating: boolean
      eventContacted: boolean
      perspective: null
      presentedScene: CraneReachScene
      currentScene: CraneReachScene
      refreshVisual(): void
      ensureBattlefield: ReturnType<typeof vi.fn>
      installFog: ReturnType<typeof vi.fn>
      reconcilePresentedScene: ReturnType<typeof vi.fn>
      reconcileEvent: ReturnType<typeof vi.fn>
    }
    const renderer = Object.create(CraneReachRenderer.prototype) as TerminalRefreshHarness
    Object.assign(renderer, {
      eventAnimating: true,
      eventContacted: true,
      perspective: null,
      presentedScene: prior,
      currentScene: terminal,
      ensureBattlefield: vi.fn(),
      installFog: vi.fn(),
      reconcilePresentedScene: vi.fn(),
      reconcileEvent: vi.fn(),
    })

    renderer.refreshVisual()

    expect(renderer.installFog).toHaveBeenCalledWith(terminal, null, false)
    expect(renderer.reconcilePresentedScene).toHaveBeenCalledWith(prior, true, true)
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
