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
    // Dense ranking: the two tied -2 seats share gold, then the next distinct scores take silver and
    // bronze with no gap (a rank is not skipped by the tie).
    expect(standings.map((s) => s.medal)).toEqual(['gold', 'gold', 'silver', 'bronze'])
    expect(standings.map((s) => s.label)).toEqual(['North', 'South', 'West', 'East'])
  })

  it('gives a tied partnership two matching medals (Spades dense ranking)', () => {
    // A Spades terminal frame carries each seat's team score, so partners tie by construction: the
    // winning pair both take gold and the losing pair both silver, not split by row position.
    const state = stepState(
      { player_3: 57 },
      {
        leaderboard_scores: [-12, 57, -12, 57],
        display_scores: [-12, 57, -12, 57],
        terminal: true,
      },
    )
    const standings = buildStandings(state, null)
    // Seats 1 & 3 (the 57 team) rank above seats 0 & 2 (the -12 team).
    expect(standings.map((s) => s.slot)).toEqual(['player_1', 'player_3', 'player_0', 'player_2'])
    expect(standings.map((s) => s.medal)).toEqual(['gold', 'gold', 'silver', 'silver'])
  })

  it('awards distinct medals with no ties (gold/silver/bronze then nothing)', () => {
    const state = stepState(
      { player_0: 0 },
      { leaderboard_scores: [10, 5, 0, -5], display_scores: [10, 5, 0, -5], terminal: true },
    )
    const standings = buildStandings(state, null)
    expect(standings.map((s) => s.medal)).toEqual(['gold', 'silver', 'bronze', null])
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

  it('labels a human seat by its name and respects the blind policy for submitted agents and other humans', () => {
    const state = stepState(
      { player_1: -3 },
      { leaderboard_scores: [0, -3], display_scores: [0, 3] },
    )
    const players: NonNullable<RecordingHeader['players']> = {
      player_0: { kind: 'human', label: 'you', user: 'viewer' },
      player_1: { kind: 'agent', label: "maya's agent", user: 'maya', submission_id: 'sub-maya' },
    }

    // Operator / closed season: real labels, no "(you)" doubling on the already-named human seat.
    const open = buildStandings(state, header(players))
    expect(open.map((s) => s.label)).toEqual(['you', "maya's agent"])

    // A non-operator viewing a playable season sees the submitted agent anonymized; the human seat is
    // the viewer's own, so it keeps its display name.
    const blind = buildStandings(state, header(players), {
      blind: true,
      viewerId: 'viewer',
      anonymousNumbers: { 'sub-maya': 1 },
    })
    expect(blind.map((s) => s.label)).toEqual(['you', 'Agent 1'])

    // A different (non-owning) viewer sees the human seat masked to the bare neutral label too: public
    // leaderboard payloads already pair a submitted agent's user_id with its user_name, so an opaque id
    // would be trivially reversible — the mask must hide the identity outright, not just the name.
    const blindOther = buildStandings(state, header(players), {
      blind: true,
      viewerId: 'someone-else',
      anonymousNumbers: { 'sub-maya': 1 },
    })
    expect(blindOther.map((s) => s.label)).toEqual(['Human', 'Agent 1'])
  })

  it('fails closed the "own row" exemption for an anonymous viewer against a header entry with no user id', () => {
    // Both the human-seat exemption and the "Your agent" branch key off `player.user === ctx.viewerId`.
    // An anonymous viewer has `viewerId === undefined`, and a header entry can likewise carry no `user`
    // (schema-optional). Without requiring both ids to be defined, `undefined === undefined` would wrongly
    // grant an anonymous viewer the "this is my own row" exemption: the human's real name would leak and
    // the ownerless agent would misread as "Your agent" instead of the neutral blind label.
    const state = stepState(
      { player_1: -3 },
      { leaderboard_scores: [0, -3], display_scores: [0, 3] },
    )
    const players: NonNullable<RecordingHeader['players']> = {
      player_0: { kind: 'human', label: 'Some Human' }, // no `user` on this older/anonymous entry
      player_1: { kind: 'agent', label: "someone's agent", submission_id: 'sub-x' }, // no `user` either
    }

    const blind = buildStandings(state, header(players), { blind: true, viewerId: undefined })
    expect(blind.map((s) => s.label)).toEqual(['Human', 'Agent'])
  })
})
