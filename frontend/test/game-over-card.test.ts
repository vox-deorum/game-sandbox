import type { RecordingHeader, StepState } from '@game-sandbox/schema'
import { render, screen } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'

import GameOverCard from '../src/components/GameOverCard.vue'
import { expectStandings } from './helpers/render.js'

/** A terminal step state carrying a seat-indexed leaderboard overlay (the four-seat game-over shape). */
function stepState(overlay: Record<string, unknown>): StepState {
  return {
    schema_version: 1,
    tick: 0,
    agents: { player_0: { reward: 0, score: 0 } },
    timing: { started_at: 0, duration_ms: 1 },
    overlay,
  }
}

describe('GameOverCard', () => {
  it('tags each ranked row with its seat id', () => {
    // A Spades board where every seat is the same baseline: without the seat tag the four rows would
    // all read "Naive agent" with no way to tell which is which.
    const state = stepState({
      leaderboard_scores: [0, -5, 10, 5],
      display_scores: [0, -5, 10, 5],
      terminal: true,
    })
    const header: RecordingHeader = {
      schema_version: 1,
      environment: 'spades',
      parameters: { players: 4 },
      players: {
        player_0: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
        player_1: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
        player_2: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
        player_3: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
      },
      seats: {
        seat_0: ['player_0'],
        seat_1: ['player_1'],
        seat_2: ['player_2'],
        seat_3: ['player_3'],
      },
      seat_plan: 'solo',
    }

    render(GameOverCard, {
      props: {
        state,
        header,
        playerScores: { player_0: 0, player_1: -5, player_2: 10, player_3: 5 },
      },
    })

    // Ranked best-first. Rows are seats, so they carry seat tags ("S0") rather than player tags
    // ("P0"): the two are numbered independently and a seat may cover more than one player.
    const seats = screen.getAllByText(/^S\d$/).map((el) => el.textContent)
    expect(seats).toEqual(['S2', 'S3', 'S0', 'S1'])
    expectStandings(
      document.body,
      [
        ['S2', 'Naive agent', '10'],
        ['S3', 'Naive agent', '5'],
        ['S0', 'Naive agent', '0'],
        ['S1', 'Naive agent', '-5'],
      ],
      'S2 won',
    )
    expect(screen.getAllByText('Naive agent')).toHaveLength(4)
  })

  it('labels a wide seat and shows its player membership', () => {
    const state = stepState({
      leaderboard_scores: [10, 7, 2],
      display_scores: [10, 7, 2],
      terminal: true,
    })
    const header: RecordingHeader = {
      schema_version: 1,
      environment: 'synthetic',
      parameters: { seat_plan: 'uneven' },
      players: {
        player_0: { kind: 'agent', label: "Alice's agent", submission_id: 'sub-alice' },
        player_1: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
        player_2: { kind: 'agent', label: "Alice's agent", submission_id: 'sub-alice' },
      },
      seats: {
        seat_0: ['player_0', 'player_2'],
        seat_1: ['player_1'],
      },
      seat_plan: 'uneven',
    }

    render(GameOverCard, {
      props: { state, header, playerScores: { player_0: 10, player_1: 7, player_2: 2 } },
    })

    expectStandings(
      document.body,
      [
        ['S1', 'Naive agent', '7'],
        ['S0', "Alice's agent", 'P0, P2', '6'],
      ],
      'S1 won',
    )
  })

  it('keeps the canonical tie copy when opposing seats share the top score', () => {
    const state = stepState({
      leaderboard_scores: [10, 10],
      display_scores: [10, 10],
      terminal: true,
    })
    const header: RecordingHeader = {
      schema_version: 1,
      environment: 'synthetic',
      parameters: { players: 2 },
      players: {
        player_0: { kind: 'agent', builtin_name: 'naive', label: 'A' },
        player_1: { kind: 'agent', builtin_name: 'naive', label: 'B' },
      },
      seats: { seat_0: ['player_0'], seat_1: ['player_1'] },
      seat_plan: 'solo',
    }
    render(GameOverCard, {
      props: { state, header, playerScores: { player_0: 10, player_1: 10 } },
    })
    expect(screen.getByText('Tied')).toBeInTheDocument()
  })
})
