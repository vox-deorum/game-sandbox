import { fireEvent, screen, within } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PublicSeasonView, RecordingSummary } from '../src/api/client.js'
import { flappyMeta } from './helpers/fixtures.js'
import { signedInMe } from './helpers/me.js'
import { memoryRouter, renderWithMe } from './helpers/render.js'

vi.mock('../src/api/client.js', () => ({
  getEnvironments: vi.fn(),
  getMe: vi.fn(),
  listRecordings: vi.fn(),
  listSeasons: vi.fn(),
  watchAgentNumbers: vi.fn(async () => ({})),
}))

import {
  getEnvironments,
  getMe,
  listRecordings,
  listSeasons,
  watchAgentNumbers,
} from '../src/api/client.js'
import ReplaysPage from '../src/pages/ReplaysPage.vue'

function recording(
  overrides: Omit<Partial<RecordingSummary>, 'header'> & {
    header?: Partial<RecordingSummary['header']>
  } = {},
): RecordingSummary {
  const { header: headerOverrides, ...rest } = overrides
  const header = {
    schema_version: 1 as const,
    environment: 'flappy_bird',
    parameters: { players: 1, pipe_gap: 100 },
    players: {
      player_0: { kind: 'agent' as const, builtin_name: 'naive', label: 'Naive agent' },
    },
    seats: { seat_0: ['player_0'] as [string] },
    seat_plan: 'solo',
  }
  return {
    id: 'flappy_bird-1',
    header: { ...header, ...headerOverrides },
    user_id: 'alice',
    created_at: '2026-06-11T00:00:00.000Z',
    pinned: false,
    termination_reason: 'terminated',
    winner_id: null,
    season_id: null,
    ...rest,
  }
}

function season(overrides: Partial<PublicSeasonView> = {}): PublicSeasonView {
  return {
    id: 'season-1',
    env_id: 'flappy_bird',
    submission_status: 'closed',
    play_status: 'open',
    release_status: 'unreleased',
    label: 'Week 1',
    description_markdown: null,
    created_at: '2026-06-01T00:00:00Z',
    released_at: null,
    submission_count: 0,
    game_count: 0,
    ...overrides,
  }
}

async function renderPage() {
  const router = memoryRouter([
    { path: '/environments/:envId/replays', component: ReplaysPage },
    { path: '/environments/:envId', component: { template: '<div />' } },
    { path: '/environments/:envId/leaderboards/:seasonId?', component: { template: '<div />' } },
    { path: '/environments/:envId/agents/:ownerId', component: { template: '<div />' } },
    { path: '/replays/:id', component: { template: '<div />' } },
  ])
  await router.push('/environments/flappy_bird/replays')
  await router.isReady()
  return renderWithMe(router)
}

/** The first data row of the replays table (after the header row), in DOM order. */
function firstBodyRow(): HTMLElement {
  const table = screen.getByRole('table')
  const [, first] = within(table).getAllByRole('row') // [0] is the header row
  if (first === undefined) {
    throw new Error('expected at least one data row')
  }
  return first
}

describe('ReplaysPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getEnvironments).mockResolvedValue([flappyMeta()])
    vi.mocked(getMe).mockResolvedValue(signedInMe('alice'))
    vi.mocked(listSeasons).mockResolvedValue([season()])
  })

  it('renders a row per replay with the season label, outcome, owner, and seat summary', async () => {
    vi.mocked(listRecordings).mockResolvedValue([
      recording({
        id: 'flappy_bird-12345678-abcd-ef01-2345-6789abcdef01',
        season_id: 'season-1',
        winner_id: 'seat_2',
        header: {
          schema_version: 1,
          environment: 'flappy_bird',
          parameters: { players: 1, pipe_gap: 100 },
          players: {
            player_0: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
            player_1: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
            player_2: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
          },
          seats: {
            seat_0: ['player_0'],
            seat_1: ['player_1'],
            seat_2: ['player_2'],
          },
          seat_plan: 'solo',
        },
      }),
    ])
    await renderPage()

    // Only the final id section is shown, but the link still targets the full recording id.
    const link = await screen.findByRole('link', { name: '6789abcdef01' })
    expect(link).toHaveAttribute(
      'href',
      '/replays/flappy_bird-12345678-abcd-ef01-2345-6789abcdef01',
    )
    // The recordings read is scoped to the environment in the route.
    expect(vi.mocked(listRecordings)).toHaveBeenCalledWith({ env: 'flappy_bird' })

    const row = link.closest('tr') as HTMLElement
    expect(within(row).getByText('Week 1')).toBeInTheDocument() // season label, not the raw id
    // The outcome and the controller summary both name seats, so the row cannot describe a different
    // number of competitors in two adjacent cells.
    expect(within(row).getByText('S2 won')).toBeInTheDocument()
    expect(within(row).getByText(/S0: Naive agent/)).toBeInTheDocument()
    // No user_name on this fixture, so the Owner cell falls back to the stable user_id, kept as its
    // own tooltip.
    const ownerCell = within(row).getByText('alice')
    expect(ownerCell).toHaveAttribute('title', 'alice')
    const cells = within(row).getAllByRole('cell')
    expect(cells[0]).toBe(ownerCell)
    expect(cells[1]).toContainElement(link)
    expect(within(row).getByText(/Naive agent/)).toBeInTheDocument()
    expect(vi.mocked(watchAgentNumbers)).not.toHaveBeenCalled()
  })

  it('shows a tie when multiple players share the eligible top rank', async () => {
    vi.mocked(listRecordings).mockResolvedValue([
      recording({ id: 'flappy_bird-tied', winner_id: -1 }),
    ])
    await renderPage()

    const row = (await screen.findByRole('link', { name: 'tied' })).closest('tr') as HTMLElement
    expect(within(row).getByText('Tied')).toBeInTheDocument()
  })

  it('names a decisive wide-seat winner by seat', async () => {
    vi.mocked(listRecordings).mockResolvedValue([
      recording({
        id: 'synthetic-wide',
        winner_id: 'seat_0',
        header: {
          environment: 'synthetic',
          parameters: { seat_plan: 'partners' },
          players: {
            player_0: { kind: 'agent', label: "Alice's agent", submission_id: 'sub-alice' },
            player_1: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
            player_2: { kind: 'agent', label: "Alice's agent", submission_id: 'sub-alice' },
          },
          seats: {
            seat_0: ['player_0', 'player_2'],
            seat_1: ['player_1'],
          },
          seat_plan: 'partners',
        },
      }),
    ])
    await renderPage()

    const row = (await screen.findByRole('link', { name: 'wide' })).closest('tr') as HTMLElement
    expect(within(row).getByText('S0 won')).toBeInTheDocument()
  })

  it('keeps the termination label when final ranking data is unavailable', async () => {
    vi.mocked(listRecordings).mockResolvedValue([recording({ id: 'flappy_bird-unknown' })])
    await renderPage()

    const row = (await screen.findByRole('link', { name: 'unknown' })).closest('tr') as HTMLElement
    expect(within(row).getByText('Game over')).toBeInTheDocument()
  })

  it('prefers the recording user_name over user_id in the Owner column, keeping the id as a tooltip', async () => {
    vi.mocked(listRecordings).mockResolvedValue([
      recording({
        id: 'flappy_bird-1',
        user_id: 'alice',
        user_name: 'Alice Nguyen',
        season_id: null,
      }),
    ])
    await renderPage()

    const link = await screen.findByRole('link', { name: '1' })
    const row = link.closest('tr') as HTMLElement
    const ownerCell = within(row).getByText('Alice Nguyen')
    expect(ownerCell).toHaveAttribute('title', 'alice')
    expect(within(row).queryByText('alice', { exact: true })).toBeNull()
  })

  it('shows the human label (name) rather than the stable user id in the players summary, with the id as a tooltip', async () => {
    vi.mocked(listRecordings).mockResolvedValue([
      recording({
        id: 'flappy_bird-1',
        season_id: null,
        header: {
          schema_version: 1,
          environment: 'flappy_bird',
          parameters: { players: 1, pipe_gap: 100 },
          players: { player_0: { kind: 'human', label: 'Alice Nguyen', user: 'alice' } },
        },
      }),
    ])
    await renderPage()

    const seatsCell = await screen.findByText(/Human \(Alice Nguyen\)/)
    expect(seatsCell).toBeInTheDocument()
    expect(screen.queryByText(/Human \(alice\)/)).toBeNull()
    // Not blind (no season), so the stable id still rides as the cell's tooltip.
    expect(seatsCell).toHaveAttribute('title', 'alice')
  })

  it("masks a blind replay's human player to the neutral label, with no name and no tooltip", async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('viewer'))
    vi.mocked(listSeasons).mockImplementation(async (_envId, options) => {
      if (options?.includeUnreleased === true) {
        throw new Error('operator access required')
      }
      return [season()]
    })
    vi.mocked(listRecordings).mockResolvedValue([
      recording({
        id: 'flappy_bird-blind-human',
        user_id: 'alice-chen',
        season_id: 'season-1',
        header: {
          schema_version: 1,
          environment: 'flappy_bird',
          parameters: { players: 1, pipe_gap: 100 },
          players: {
            player_0: { kind: 'human', label: 'Alice Chen', user: 'alice-chen' },
            player_1: {
              kind: 'agent',
              label: "maya-fledgling's agent",
              user: 'maya-fledgling',
              submission_id: 'sub-maya',
            },
          },
          // Both players need seats: the header's seat map is what the summary iterates, and a map
          // covering only one of them would not be a valid partition of the attributed players.
          seats: { seat_0: ['player_0'], seat_1: ['player_1'] },
        },
      }),
    ])
    vi.mocked(watchAgentNumbers).mockResolvedValue({ 'sub-maya': 1 })
    await renderPage()

    const row = (await screen.findByRole('link', { name: 'human' })).closest('tr') as HTMLElement
    const seatsCell = within(row).getByText(/: Human,/)
    expect(seatsCell.textContent).not.toContain('Alice Chen')
    expect(seatsCell.textContent).not.toContain('alice-chen')
    expect(seatsCell.textContent).not.toMatch(/Human \(/) // no parenthetical under blind
    expect(seatsCell).not.toHaveAttribute('title')
  })

  it('shows an em dash for a replay with no season or owner', async () => {
    vi.mocked(listRecordings).mockResolvedValue([
      recording({
        id: 'orphan',
        user_id: null,
        season_id: null,
        header: {
          schema_version: 1,
          environment: 'flappy_bird',
          parameters: { players: 1, pipe_gap: 100 },
        },
      }),
    ])
    await renderPage()

    const row = (await screen.findByRole('link', { name: 'orphan' })).closest('tr') as HTMLElement
    // Owner and Season fall back to the em dash. Every supported recording has player attribution.
    expect(within(row).getAllByText(String.fromCodePoint(0x2014)).length).toBeGreaterThanOrEqual(2)
  })

  it('masks submitted-agent players and owner while their season is playable', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('viewer'))
    // Mirror the backend's gate: a non-operator who asks for unreleased seasons is refused, while the
    // default public scope still surfaces the play-open (unreleased) season the masking depends on. A
    // regression that requested the operator-only listing here would yield no season, and no mask.
    vi.mocked(listSeasons).mockImplementation(async (_envId, options) => {
      if (options?.includeUnreleased === true) {
        throw new Error('operator access required')
      }
      return [season()]
    })
    vi.mocked(listRecordings).mockResolvedValue([
      recording({
        id: 'flappy_bird-blind',
        user_id: 'maya-fledgling',
        season_id: 'season-1',
        header: {
          schema_version: 1,
          environment: 'flappy_bird',
          parameters: { players: 1, pipe_gap: 100 },
          players: {
            player_0: {
              kind: 'agent',
              label: "maya-fledgling's agent",
              user: 'maya-fledgling',
              submission_id: 'sub-maya',
            },
          },
        },
      }),
    ])
    // The masked label must carry the same season-wide number the rating panel shows for this agent.
    vi.mocked(watchAgentNumbers).mockResolvedValue({ 'sub-maya': 1 })
    await renderPage()

    const row = (await screen.findByRole('link', { name: 'blind' })).closest('tr') as HTMLElement
    const seatsCell = within(row).getByText(/Agent 1/)
    expect(seatsCell).toBeInTheDocument()
    expect(within(row).queryByText('maya-fledgling')).toBeNull()
    // The masked row's identity is hidden outright, so the cell carries no id tooltip either.
    expect(seatsCell).not.toHaveAttribute('title')
    // The page leans on the public scope (which includes play-open seasons), not the operator path.
    expect(vi.mocked(listSeasons)).toHaveBeenCalledWith('flappy_bird', { includeUnreleased: false })
    expect(vi.mocked(watchAgentNumbers)).toHaveBeenCalledWith('flappy_bird')
  })

  it('re-sorts by owner when the Owner header is clicked', async () => {
    vi.mocked(listRecordings).mockResolvedValue([
      recording({ id: 'rec-a', user_id: 'zoe' }),
      recording({ id: 'rec-b', user_id: 'amy' }),
    ])
    await renderPage()
    await screen.findByRole('link', { name: 'a' })

    // Default order is the backend order (as returned): zoe's row first.
    expect(within(firstBodyRow()).getByText('zoe')).toBeInTheDocument()

    // Clicking Owner sorts descending first (zoe before amy); a second click flips to ascending.
    await fireEvent.click(screen.getByRole('button', { name: 'Owner' }))
    expect(within(firstBodyRow()).getByText('zoe')).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Owner' }))
    expect(within(firstBodyRow()).getByText('amy')).toBeInTheDocument()
  })

  it('shows an empty state when the environment has no replays', async () => {
    vi.mocked(listRecordings).mockResolvedValue([])
    await renderPage()
    expect(await screen.findByText('No replays yet.')).toBeInTheDocument()
  })
})
