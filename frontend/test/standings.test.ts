import type { RecordingHeader, StepState } from '@game-sandbox/schema'
import { describe, expect, it } from 'vitest'

import { buildStandings } from '../src/lib/standings.js'

function stepState(scores: Record<string, number>, overlay?: Record<string, unknown>): StepState {
  return {
    schema_version: 1,
    tick: 0,
    agents: Object.fromEntries(
      Object.entries(scores).map(([player, score]) => [player, { reward: 0, score }]),
    ),
    timing: { started_at: 0, duration_ms: 1 },
    ...(overlay === undefined ? {} : { overlay }),
  }
}

function header(
  players: RecordingHeader['players'],
  seats: RecordingHeader['seats'] = Object.fromEntries(
    Object.keys(players).map((player, index) => [`seat_${index}`, [player]]),
  ),
): RecordingHeader {
  return {
    schema_version: 1,
    environment: 'hearts',
    parameters: { players: 4 },
    players,
    seats,
    seat_plan: 'solo',
  }
}

describe('buildStandings without a header', () => {
  it('awards distinct medals with no ties, then nothing below the podium', () => {
    const state = stepState(
      { player_0: 0 },
      { leaderboard_scores: [10, 5, 0, -5], display_scores: [10, 5, 0, -5] },
    )
    const standings = buildStandings(state, null)
    expect(standings.map((row) => row.medal)).toEqual(['gold', 'silver', 'bronze', null])
  })

  // A recording's terminal frame carries only the acting player, so the complete picture is the
  // overlay array. Sizing the rows from `state.agents` would collapse a four-player game to one row.
  it('ranks every player from the overlay, not just the recorded final actor', () => {
    const state = stepState({ player_3: -5 }, { leaderboard_scores: [-2, -17, -2, -5] })
    const standings = buildStandings(state, null)
    expect(standings.map((row) => row.seat)).toEqual(['seat_0', 'seat_2', 'seat_3', 'seat_1'])
    expect(standings.map((row) => row.players)).toEqual([
      ['player_0'],
      ['player_2'],
      ['player_3'],
      ['player_1'],
    ])
  })

  it('shows a single gold row for a single-player game (Flappy Bird pipes)', () => {
    const state = stepState({ player_0: 12 }, { pipes_passed: 42 })
    const standings = buildStandings(state, null)
    expect(standings).toHaveLength(1)
    expect(standings[0]).toMatchObject({ seat: 'seat_0', value: 42, medal: 'gold' })
    expect(standings[0]?.label).toBe('P0') // no header, so the player id is the fallback label
  })

  it('falls back to the rounded cumulative score when the overlay ships no game score', () => {
    const state = stepState({ player_0: 3.7, player_1: 9.2 })
    const standings = buildStandings(state, null)
    expect(standings.map((row) => row.players)).toEqual([['player_1'], ['player_0']])
    expect(standings.map((row) => row.value)).toEqual([9, 4])
  })
})

describe('buildStandings', () => {
  it('keeps singleton standings behavior while identifying rows by seat', () => {
    const state = stepState(
      { player_3: -5 },
      { leaderboard_scores: [-2, -17, -2, -5], display_scores: [2, 17, 2, 5] },
    )
    const standings = buildStandings(
      state,
      header({
        player_0: { kind: 'agent', builtin_name: 'naive', label: 'North' },
        player_1: { kind: 'agent', builtin_name: 'naive', label: 'East' },
        player_2: { kind: 'agent', builtin_name: 'naive', label: 'South' },
        player_3: { kind: 'agent', builtin_name: 'naive', label: 'West' },
      }),
    )

    expect(standings.map((row) => row.seat)).toEqual(['seat_0', 'seat_2', 'seat_3', 'seat_1'])
    expect(standings.map((row) => row.value)).toEqual([2, 2, 5, 17])
    expect(standings.map((row) => row.medal)).toEqual(['gold', 'gold', 'silver', 'bronze'])
    expect(standings.map((row) => row.label)).toEqual(['North', 'South', 'West', 'East'])
  })

  it('reduces a partnership into one row and keeps its player membership', () => {
    const state = stepState(
      { player_3: 3 },
      { leaderboard_scores: [12, 3, 12, 3], display_scores: [12, 3, 12, 3] },
    )
    const standings = buildStandings(
      state,
      header(
        {
          player_0: { kind: 'agent', builtin_name: 'naive', label: 'North' },
          player_1: { kind: 'agent', builtin_name: 'naive', label: 'East' },
          player_2: { kind: 'agent', builtin_name: 'naive', label: 'North' },
          player_3: { kind: 'agent', builtin_name: 'naive', label: 'East' },
        },
        { seat_0: ['player_0', 'player_2'], seat_1: ['player_1', 'player_3'] },
      ),
    )

    expect(standings).toMatchObject([
      {
        seat: 'seat_0',
        label: 'North',
        players: ['player_0', 'player_2'],
        value: 12,
        medal: 'gold',
      },
      {
        seat: 'seat_1',
        label: 'East',
        players: ['player_1', 'player_3'],
        value: 3,
        medal: 'silver',
      },
    ])
  })

  it('puts a human before its companion and collapses repeated companion labels', () => {
    const state = stepState(
      { player_0: 4, player_1: 4, player_2: 4 },
      { leaderboard_scores: [4, 4, 4], display_scores: [4, 4, 4] },
    )
    const standings = buildStandings(
      state,
      header(
        {
          player_0: { kind: 'agent', builtin_name: 'naive', label: 'Companion' },
          player_1: { kind: 'human', label: 'Ada', user: 'ada' },
          player_2: { kind: 'agent', builtin_name: 'naive', label: 'Companion' },
        },
        { seat_0: ['player_0', 'player_1', 'player_2'] },
      ),
    )

    expect(standings[0]).toMatchObject({
      label: 'Ada, Companion',
      players: ['player_0', 'player_1', 'player_2'],
    })
  })

  it('applies blind controller labels before collapsing a seat', () => {
    const state = stepState({ player_0: 1, player_1: 1 }, { leaderboard_scores: [1, 1] })
    const standings = buildStandings(
      state,
      header(
        {
          player_0: {
            kind: 'agent',
            label: "maya's agent",
            user: 'maya',
            submission_id: 'sub-maya',
          },
          player_1: {
            kind: 'agent',
            label: "maya's agent",
            user: 'maya',
            submission_id: 'sub-maya',
          },
        },
        { seat_0: ['player_0', 'player_1'] },
      ),
      { blind: true, viewerId: 'viewer', anonymousNumbers: { 'sub-maya': 1 } },
    )
    expect(standings[0]?.label).toBe('Agent 1')
  })

  // Both the human-seat exemption and the "Your agent" branch key off `player.user === viewerId`.
  // An anonymous viewer has no `viewerId`, and a header entry can carry no `user` either. Without
  // requiring both to be defined, `undefined === undefined` would read as "this is my own row" and
  // hand an anonymous viewer somebody else's identity: the human's real name would show and the
  // ownerless agent would read "Your agent" instead of the neutral blind label.
  it('fails closed the own-row exemption for an anonymous viewer against an entry with no user id', () => {
    const state = stepState({ player_1: -3 }, { leaderboard_scores: [0, -3] })
    const standings = buildStandings(
      state,
      header({
        player_0: { kind: 'human', label: 'Some Human' },
        player_1: { kind: 'agent', label: "someone's agent", submission_id: 'sub-x' },
      }),
      { blind: true, viewerId: undefined },
    )

    expect(standings.map((row) => row.label)).toEqual(['Human', 'Agent'])
  })
})
