import { render, screen } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import type { RunGameView } from '../src/api/client.js'
import { MeProvider } from '../src/me.js'
import { anonymousMe, signedInMe } from './helpers/me.js'

vi.mock('../src/api/client.js', () => ({
  getMe: vi.fn(async () => ({ user: null })),
}))

import { getMe } from '../src/api/client.js'
import GamesTable from '../src/components/GamesTable.vue'
import { memoryRouter } from './helpers/render.js'

/** A three-seat game: two submitted agents and the built-in baseline, with per-seat results. */
function game(overrides: Partial<RunGameView> = {}): RunGameView {
  return {
    id: 'game-1',
    run_id: 'run-1',
    match_index: 0,
    game_index: 1,
    seed: 7,
    seats: [
      { kind: 'submission', submission_id: 'sub-a', user_id: 'user-a', user_name: 'Ada' },
      { kind: 'submission', submission_id: 'sub-b', user_id: 'user-b', user_name: 'Bob' },
      { kind: 'builtin', name: 'naive', label: 'Naive agent' },
    ],
    results: [
      { seat_index: 0, episode_score: 26, failed: false },
      { seat_index: 1, episode_score: 3.5, failed: false },
      { seat_index: 2, episode_score: -26, failed: true },
    ],
    status: 'completed',
    recording_id: 'rec-1',
    started_at: null,
    ended_at: null,
    error: null,
    ...overrides,
  }
}

async function renderTable(games: RunGameView[]) {
  const router = memoryRouter([
    { path: '/', component: { template: '<div />' } },
    { path: '/replays/:id', component: { template: '<div />' } },
  ])
  await router.push('/')
  const view = render(MeProvider, {
    slots: { default: () => h(GamesTable, { games, liveStatus: {} }) },
    global: { plugins: [router] },
  })
  await screen.findAllByTestId('game-seat')
  return view
}

describe('GamesTable', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getMe).mockResolvedValue(signedInMe('viewer'))
  })

  it('shows each seat with its score, the top scorer bold and a failed seat tagged', async () => {
    await renderTable([game()])
    const seats = screen.getAllByTestId('game-seat')
    expect(seats.map((seat) => seat.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Ada 26',
      'Bob 3.50',
      'Naive agent -26 failed',
    ])
    expect(seats.map((seat) => seat.classList.contains('winner'))).toEqual([true, false, false])
  })

  it('bolds every seat tied for the top score', async () => {
    await renderTable([
      game({
        results: [
          { seat_index: 0, episode_score: 10, failed: false },
          { seat_index: 1, episode_score: 10, failed: false },
          { seat_index: 2, episode_score: 2, failed: false },
        ],
      }),
    ])
    const winners = screen
      .getAllByTestId('game-seat')
      .map((seat) => seat.classList.contains('winner'))
    expect(winners).toEqual([true, true, false])
  })

  it('shows names only for a game without results yet', async () => {
    await renderTable([game({ results: [], status: 'pending', recording_id: null })])
    const seats = screen.getAllByTestId('game-seat')
    expect(seats.map((seat) => seat.textContent?.trim())).toEqual(['Ada', 'Bob', 'Naive agent'])
    expect(seats.some((seat) => seat.classList.contains('winner'))).toBe(false)
  })
  it('pairs unordered results with their seat indexes', async () => {
    await renderTable([
      game({
        results: [
          { seat_index: 2, episode_score: -26, failed: true },
          { seat_index: 0, episode_score: 26, failed: false },
          { seat_index: 1, episode_score: 3.5, failed: false },
        ],
      }),
    ])
    const seats = screen.getAllByTestId('game-seat')
    expect(seats.map((seat) => seat.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Ada 26',
      'Bob 3.50',
      'Naive agent -26 failed',
    ])
    expect(seats.map((seat) => seat.classList.contains('winner'))).toEqual([true, false, false])
  })

  it('ranks zero above negative scores', async () => {
    await renderTable([
      game({
        results: [
          { seat_index: 0, episode_score: -1, failed: false },
          { seat_index: 1, episode_score: 0, failed: false },
          { seat_index: 2, episode_score: -3, failed: false },
        ],
      }),
    ])
    const seats = screen.getAllByTestId('game-seat')
    expect(seats.map((seat) => seat.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Ada -1',
      'Bob 0',
      'Naive agent -3',
    ])
    expect(seats.map((seat) => seat.classList.contains('winner'))).toEqual([false, true, false])
  })

  it('excludes a failed seat tied at the top from the winners', async () => {
    await renderTable([
      game({
        results: [
          { seat_index: 0, episode_score: 10, failed: true },
          { seat_index: 1, episode_score: 10, failed: false },
          { seat_index: 2, episode_score: 2, failed: false },
        ],
      }),
    ])
    const seats = screen.getAllByTestId('game-seat')
    expect(seats[0]).toHaveTextContent('Ada 10 failed')
    expect(seats.map((seat) => seat.classList.contains('winner'))).toEqual([false, true, false])
  })

  it('declares no winner when all seats failed', async () => {
    await renderTable([
      game({
        results: [
          { seat_index: 0, episode_score: 10, failed: true },
          { seat_index: 1, episode_score: 3, failed: true },
          { seat_index: 2, episode_score: 1, failed: true },
        ],
      }),
    ])
    const seats = screen.getAllByTestId('game-seat')
    for (const seat of seats) {
      expect(seat).toHaveTextContent('failed')
      expect(seat).not.toHaveClass('winner')
    }
  })

  it.each([
    ['anonymous', anonymousMe],
    ['guest', signedInMe('guest-one', 'guest')],
  ])('masks submission names and identity tooltips for %s viewers', async (_label, me) => {
    vi.mocked(getMe).mockResolvedValue(me)
    await renderTable([game()])
    const names = screen.getAllByTestId('seat-name')
    expect(names[0]).toHaveTextContent(/^Agent [a-z0-9]+$/i)
    expect(names[1]).toHaveTextContent(/^Agent [a-z0-9]+$/i)
    expect(names[2]).toHaveTextContent('Naive agent')
    expect(names[0]?.textContent).not.toBe(names[1]?.textContent)
    expect(screen.queryByText('Ada')).toBeNull()
    expect(screen.queryByText('Bob')).toBeNull()
    const row = screen.getByTestId('game-row')
    expect(row).not.toHaveTextContent('user-a')
    expect(row).not.toHaveTextContent('user-b')
    expect(row.querySelector('[title]')).toBeNull()
  })
})
