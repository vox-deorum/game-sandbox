import type { RecordingHeader, StepState } from '@game-sandbox/schema'
import { describe, expect, it } from 'vitest'

import { buildStandings } from '../src/lib/standings.js'

/** A step state: per-slot cumulative score in the `agents` map, plus an optional environment overlay. */
function stepState(scores: Record<string, number>, overlay?: Record<string, unknown>): StepState {
  return {
    schema_version: 1,
    tick: 0,
    agents: Object.fromEntries(
      Object.entries(scores).map(([slot, score]) => [slot, { reward: 0, score }]),
    ),
    timing: { started_at: 0, duration_ms: 1 },
    ...(overlay !== undefined ? { overlay } : {}),
  }
}

function header(players: NonNullable<RecordingHeader['players']>): RecordingHeader {
  return { schema_version: 1, environment: 'hearts', players }
}

describe('buildStandings (cross-environment game-over leaderboard)', () => {
  it('ranks every Hearts seat from the overlay, not just the recorded final actor', () => {
    // A real four-seat terminal frame stores only the agent that played last in `agents`; the complete
    // per-seat standings live in the overlay (leaderboard_scores = -penalty, higher better).
    const state = stepState(
      { player_3: -5 },
      {
        leaderboard_scores: [-2, -17, -2, -5],
        display_scores: [2, 17, 2, 5],
        terminal: true,
      },
    )
    const standings = buildStandings(
      state,
      header({
        player_0: { kind: 'agent', label: 'North' },
        player_1: { kind: 'agent', label: 'East' },
        player_2: { kind: 'agent', label: 'South' },
        player_3: { kind: 'agent', label: 'West' },
      }),
    )

    // All four seats appear, ranked best-first; the -2 tie keeps its seat order (stable sort).
    expect(standings.map((s) => s.slot)).toEqual(['player_0', 'player_2', 'player_3', 'player_1'])
    expect(standings.map((s) => s.value)).toEqual([2, 2, 5, 17]) // penalty points, low (best) first
    expect(standings.map((s) => s.medal)).toEqual(['gold', 'silver', 'bronze', null])
    expect(standings.map((s) => s.label)).toEqual(['North', 'South', 'West', 'East'])
  })

  it('shows a single gold row for a single-player game (Flappy Bird pipes)', () => {
    const state = stepState({ player_0: 12 }, { pipes_passed: 42 })
    const standings = buildStandings(state, null)
    expect(standings).toHaveLength(1)
    expect(standings[0]).toMatchObject({ slot: 'player_0', value: 42, medal: 'gold' })
    expect(standings[0]?.label).toBe('Player 0') // no header → slot fallback
  })

  it('falls back to the rounded cumulative score when the overlay ships no game score', () => {
    const state = stepState({ player_0: 3.7, player_1: 9.2 })
    const standings = buildStandings(state, null)
    expect(standings.map((s) => s.slot)).toEqual(['player_1', 'player_0']) // higher score wins
    expect(standings.map((s) => s.value)).toEqual([9, 4]) // rounded
  })

  it('labels a human seat by its name and respects the blind policy for submitted agents', () => {
    const state = stepState(
      { player_1: -3 },
      { leaderboard_scores: [0, -3], display_scores: [0, 3] },
    )
    const players: NonNullable<RecordingHeader['players']> = {
      player_0: { kind: 'human', label: 'you' },
      player_1: { kind: 'agent', label: "maya's agent", user: 'maya', submission_id: 'sub-maya' },
    }

    // Operator / closed season: real labels, no "(you)" doubling on the already-named human seat.
    const open = buildStandings(state, header(players))
    expect(open.map((s) => s.label)).toEqual(['you', "maya's agent"])

    // A non-operator viewing a playable season sees the submitted agent anonymized; the human is
    // unaffected.
    const blind = buildStandings(state, header(players), {
      blind: true,
      viewerId: 'viewer',
      anonymousNumbers: { 'sub-maya': 1 },
    })
    expect(blind.map((s) => s.label)).toEqual(['you', 'Submitted agent 1'])
  })
})
