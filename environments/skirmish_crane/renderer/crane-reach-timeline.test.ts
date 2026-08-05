import { describe, expect, it } from 'vitest'

import {
  eventBudget,
  eventPhaseAt,
  eventTimelineBounds,
  eventTimelineProgress,
  hostEase,
  routePositionFor,
  routeTrailFor,
} from './timeline.js'

describe('Crane Reach event timeline', () => {
  it('uses the full host cadence and snaps a zero-duration seek', () => {
    expect(eventBudget()).toBe(1_000)
    expect(eventBudget({ transitionMs: 300 })).toBe(300)
    expect(eventBudget({ transitionMs: 750 })).toBe(750)
    expect(eventBudget({ transitionMs: 1_000 })).toBe(1_000)
    expect(eventBudget({ snap: true, transitionMs: 0 })).toBe(0)
    expect(hostEase(0)).toBe(0)
    expect(hostEase(0.2)).toBeCloseTo(0.5, 4)
    expect(hostEase(1)).toBe(1)
  })

  it('interpolates tile-aware movement into one overlapping resolution phase', () => {
    expect(eventTimelineBounds(0)).toMatchObject({ movementEnd: 0.15, resolutionStart: 0.65 })
    expect(eventTimelineBounds(1)).toMatchObject({ movementEnd: 0.5, resolutionStart: 0.65 })
    expect(eventTimelineBounds(2)).toMatchObject({
      movementEnd: 7 / 12,
      resolutionStart: 41 / 60,
    })
    expect(eventTimelineBounds(3)).toMatchObject({
      movementEnd: 2 / 3,
      resolutionStart: 43 / 60,
    })
    expect(eventTimelineBounds(4)).toMatchObject({ movementEnd: 0.75, resolutionStart: 0.75 })
    expect(eventPhaseAt(0, true, true, true, 1)).toBe('activation')
    expect(eventPhaseAt(0.4, true, true, true, 1)).toBe('movement')
    expect(eventPhaseAt(0.55, true, true, true, 1)).toBe('settle')
    expect(eventPhaseAt(0.65, true, true, true, 1)).toBe('resolution')
    expect(eventPhaseAt(0.74, true, true, true, 4)).toBe('movement')
    expect(eventPhaseAt(0.75, true, true, true, 4)).toBe('resolution')
    expect(eventPhaseAt(1, true)).toBe('idle')
    expect(eventPhaseAt(0.4, true, true, false)).toBe('idle')
    expect(eventTimelineProgress(0.1, true, true, 1)).toEqual({
      movement: 0,
      attack: 0,
      reaction: 0,
    })
    const movement = eventTimelineProgress(0.4, true, true, 1)
    expect(movement.movement).toBeGreaterThan(0)
    expect(movement).toMatchObject({ attack: 0, reaction: 0 })
    const attack = eventTimelineProgress(0.7, true, true, 1)
    expect(attack.attack).toBeGreaterThan(0)
    expect(attack).toMatchObject({ movement: 1, reaction: 0 })
    const reaction = eventTimelineProgress(0.8, true, true, 1)
    expect(reaction.reaction).toBeGreaterThan(0)
    expect(reaction.attack).toBeGreaterThan(0)

    const movementOnly = eventTimelineProgress(0.9, false, false, 1)
    expect(movementOnly.movement).toBe(1)
    expect(movementOnly.attack).toBe(0)
    expect(movementOnly.reaction).toBe(0)

    const captureOnly = eventTimelineProgress(0.7, false, true, 0)
    expect(captureOnly).toMatchObject({ movement: 0, attack: 0 })
    expect(captureOnly.reaction).toBeGreaterThan(0)
    expect(eventPhaseAt(0.7, false, true, true, 0)).toBe('resolution')
  })

  it('walks a route one tile at a time and trails the tiles already entered', () => {
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
