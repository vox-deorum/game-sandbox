import type { RecordingHeader, StepState } from '@game-sandbox/schema'
import { render, screen } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'

import GameOverCard from '../src/components/GameOverCard.vue'

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
  it('labels each finisher by seat number and agent name, so identical agent labels stay apart', () => {
    // A Spades board where every seat is the same baseline: without the seat tag the four rows would
    // all read "Naive agent" with no way to tell which is which.
    const state = stepState({
      leaderboard_scores: [10, 5, 0, -5],
      display_scores: [10, 5, 0, -5],
      terminal: true,
    })
    const header: RecordingHeader = {
      schema_version: 1,
      environment: 'spades',
      parameters: { players: 4 },
      players: {
        player_0: { kind: 'agent', label: 'Naive agent' },
        player_1: { kind: 'agent', label: 'Naive agent' },
        player_2: { kind: 'agent', label: 'Naive agent' },
        player_3: { kind: 'agent', label: 'Naive agent' },
      },
    }

    render(GameOverCard, { props: { state, header } })

    // Ranked best-first, each row carries its seat tag (P0…P3) alongside the shared agent name.
    const seats = screen.getAllByText(/^P\d$/).map((el) => el.textContent)
    expect(seats).toEqual(['P0', 'P1', 'P2', 'P3'])
    expect(screen.getAllByText('Naive agent')).toHaveLength(4)
  })
})
