/**
 * Fog of war: whose eyes a frame is drawn through, and what that leaves on the board.
 */
import type { RecordingHeader, StepState } from '@game-sandbox/schema'
import { describe, expect, it } from 'vitest'

import { eventVisible, perspectiveFor, visibleUnits, visionRadius } from './fog.js'
import { hexDistance, type SceneUnit, tileCoordinate } from './scene.js'
import {
  armyScene,
  armyStates,
  skirmishScene,
  skirmishStates,
} from './test-helpers.js'

const SEATS: RecordingHeader['seats'] = {
  seat_0: ['player_0', 'player_1', 'player_2'],
  seat_1: ['player_3', 'player_4', 'player_5'],
}

/** The first recorded frame whose activation belongs to the given seat. */
function frameActingFor(players: readonly string[]): StepState {
  const state = skirmishStates.find((candidate) =>
    players.includes(skirmishScene(candidate).activation?.playerId ?? ''),
  )
  expect(state).toBeDefined()
  return state as StepState
}

describe('Crane Reach fog of war', () => {
  it('draws the acting unit own vision on a controlled turn', () => {
    const state = frameActingFor(['player_0'])
    const scene = skirmishScene(state)
    const perspective = perspectiveFor(scene, ['player_0'], SEATS)
    expect(perspective?.observers).toEqual(['player_0'])
  })

  it('draws the companion own vision when a seatmate acts', () => {
    const state = frameActingFor(['player_1'])
    const scene = skirmishScene(state)
    // The person controls the seat primary unit only; player_1 is a companion in the same seat.
    const perspective = perspectiveFor(scene, ['player_0'], SEATS)
    expect(perspective?.observers).toEqual(['player_1'])
  })

  it('unions the whole seat on an opponent turn', () => {
    const state = frameActingFor(['player_3', 'player_4', 'player_5'])
    const scene = skirmishScene(state)
    const perspective = perspectiveFor(scene, ['player_0'], SEATS)
    const living = scene.units.map((unit) => unit.playerId)
    expect(perspective?.observers).toEqual(
      ['player_0', 'player_1', 'player_2'].filter((player) => living.includes(player)),
    )
  })

  it('keeps the union going after a controlled unit dies, using the companions that remain', () => {
    const state = frameActingFor(['player_3', 'player_4', 'player_5'])
    const overlay = state.overlay as Record<string, unknown>
    const records = (overlay.u as string[]).filter((record) => !record.startsWith('00'))
    const visibility = [...(overlay.v as (string | null)[])]
    visibility[0] = null
    const bereaved = skirmishScene({ ...state, overlay: { ...overlay, u: records, v: visibility } })

    const perspective = perspectiveFor(bereaved, ['player_0'], SEATS)
    expect(perspective?.observers).not.toContain('player_0')
    expect(perspective?.observers.length).toBeGreaterThan(0)
    expect(perspective?.tiles.size).toBeGreaterThan(0)
  })

  it('hides nothing from a spectator, a replay viewer, or a finished match', () => {
    const state = frameActingFor(['player_0'])
    const scene = skirmishScene(state)
    expect(perspectiveFor(scene, [], SEATS)).toBeNull()
    expect(visibleUnits(scene, null)).toBe(scene.units)

    const final = skirmishScene(skirmishStates[skirmishStates.length - 1] as StepState)
    expect(final.hud.terminal).not.toBeNull()
    expect(perspectiveFor(final, ['player_0'], SEATS)).toBeNull()
  })

  it('falls back to the controlled players when no seat map names them', () => {
    const state = frameActingFor(['player_3', 'player_4', 'player_5'])
    const scene = skirmishScene(state)
    expect(perspectiveFor(scene, ['player_0'], undefined)?.observers).toEqual(['player_0'])
  })

  it('reads one further from high ground and nowhere else', () => {
    const scene = skirmishScene(skirmishStates[0] as StepState)
    const unit = scene.units[0] as SceneUnit
    expect(unit).toBeDefined()
    const hill = {
      ...scene,
      tiles: scene.tiles.map((tile) =>
        tile.key === unit.tileKey ? { ...tile, terrain: 'hill' as const } : tile,
      ),
    }
    expect(visionRadius(unit, hill)).toBe(visionRadius(unit, scene) + 1)
  })

  it('agrees with the environment about what every unit sees', () => {
    // The vision stats and the vision formula are hand copies of the engine's, while the overlay
    // masks are the engine's own output. Exact agreement on every recorded frame of both fixtures
    // is what pins the copy: a unit is in a mask exactly when it stands inside the recomputed
    // radius, so the tile veil drawn from that radius can never disagree with the units drawn from
    // the masks.
    for (const [states, sceneFor] of [
      [skirmishStates, skirmishScene],
      [armyStates, armyScene],
    ] as const) {
      const mismatches: string[] = []
      for (const [index, state] of states.entries()) {
        const scene = sceneFor(state)
        for (const [playerId, seen] of scene.visibility) {
          const observer = scene.units.find((unit) => unit.playerId === playerId) as SceneUnit
          const from = tileCoordinate(observer.tileKey)
          const radius = visionRadius(observer, scene)
          for (const unit of scene.units) {
            if (unit.unitId === observer.unitId) continue
            const within = hexDistance(from, tileCoordinate(unit.tileKey)) <= radius
            if (seen.has(unit.unitId) !== within) {
              mismatches.push(`state ${index}: ${playerId} on ${unit.unitId}`)
            }
          }
        }
      }
      expect(mismatches).toEqual([])
    }
  })

  it('depends on the state alone, so a mount mid-episode and a direct render agree', () => {
    // The renderer may mount on any frame (a reconnect drops a viewer straight into a running match)
    // and may be handed any frame directly (a replay seek). Fog is a pure function of the state, so
    // arriving late must give the same picture as having watched every frame before it.
    const midway = skirmishStates[Math.floor(skirmishStates.length / 2)] as StepState
    const cold = perspectiveFor(skirmishScene(midway), ['player_0'], SEATS)
    for (const state of skirmishStates.slice(0, Math.floor(skirmishStates.length / 2))) {
      perspectiveFor(skirmishScene(state), ['player_0'], SEATS)
    }
    const warm = perspectiveFor(skirmishScene(midway), ['player_0'], SEATS)
    expect(warm).toEqual(cold)
  })

  it('lets a move play out before the fog follows the unit acting next', () => {
    // An event runs over the frame before it, so that frame's perspective is the one that decides.
    // Judging by the arriving frame instead asks whoever acts next whether they saw it, which skips
    // a unit's own move whenever the next unit to act cannot see where it went.
    let ownMoves = 0
    let skippedByTheWrongFrame = 0
    for (const [index, state] of skirmishStates.entries()) {
      const scene = skirmishScene(state)
      const actor = scene.event?.actorId
      if (actor === undefined || actor === null || !actor.startsWith('red_')) continue
      const previous = index === 0 ? null : skirmishScene(skirmishStates[index - 1] as StepState)
      if (previous?.activation?.unitId !== actor) continue
      ownMoves += 1
      expect(eventVisible(perspectiveFor(previous, ['player_0'], SEATS), actor)).toBe(true)
      if (!eventVisible(perspectiveFor(scene, ['player_0'], SEATS), actor)) {
        skippedByTheWrongFrame += 1
      }
    }
    expect(ownMoves).toBeGreaterThan(0)
    expect(skippedByTheWrongFrame).toBeGreaterThan(0)
  })

  it('installs an activation resolved out of sight without animating it', () => {
    const state = frameActingFor(['player_3', 'player_4', 'player_5'])
    const scene = skirmishScene(state)
    const perspective = perspectiveFor(scene, ['player_0'], SEATS)
    // A unit nobody on our side can see is not one whose move we may watch.
    const unseen = scene.units.find(
      (unit) => unit.side === 'blue' && perspective?.units.has(unit.unitId) === false,
    )
    expect(unseen).toBeDefined()
    expect(eventVisible(perspective, unseen?.unitId ?? null)).toBe(false)
    // A spectator sees every move, and a frame that resolved nothing never blocks anything.
    expect(eventVisible(null, unseen?.unitId ?? null)).toBe(true)
    expect(eventVisible(perspective, null)).toBe(true)
  })

  it('keeps terrain complete, since the battlefield is standing knowledge', () => {
    const state = frameActingFor(['player_0'])
    const scene = skirmishScene(state)
    const perspective = perspectiveFor(scene, ['player_0'], SEATS)
    // The veil marks where perception ends; every tile is still in the scene and still drawn.
    expect(perspective?.tiles.size).toBeLessThan(scene.tiles.length)
    expect(scene.tiles.length).toBeGreaterThan(0)
  })
})
