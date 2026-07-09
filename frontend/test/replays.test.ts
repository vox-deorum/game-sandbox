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

function recording(overrides: Partial<RecordingSummary> = {}): RecordingSummary {
  return {
    id: 'flappy_bird-1',
    header: { schema_version: 1, environment: 'flappy_bird' },
    user_id: 'alice',
    created_at: '2026-06-11T00:00:00.000Z',
    pinned: false,
    termination_reason: 'terminated',
    season_id: null,
    ...overrides,
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

  it('renders a row per replay with the season label, outcome, owner, and player summary', async () => {
    vi.mocked(listRecordings).mockResolvedValue([
      recording({
        id: 'flappy_bird-1',
        season_id: 'season-1',
        header: {
          schema_version: 1,
          environment: 'flappy_bird',
          players: { player_0: { kind: 'agent', label: 'Naive agent' } },
        },
      }),
    ])
    await renderPage()

    // The env prefix is dropped from the displayed id (the page is already scoped to the environment),
    // but the link still targets the full recording id.
    const link = await screen.findByRole('link', { name: '1' })
    expect(link).toHaveAttribute('href', '/replays/flappy_bird-1')
    // The recordings read is scoped to the environment in the route.
    expect(vi.mocked(listRecordings)).toHaveBeenCalledWith({ env: 'flappy_bird' })

    const row = link.closest('tr') as HTMLElement
    expect(within(row).getByText('Week 1')).toBeInTheDocument() // season label, not the raw id
    expect(within(row).getByText('Game over')).toBeInTheDocument() // termination reason via reasonText
    expect(within(row).getByText('alice')).toBeInTheDocument()
    expect(within(row).getByText(/Naive agent/)).toBeInTheDocument()
  })

  it('shows an em dash for a replay with no season, owner, or players', async () => {
    vi.mocked(listRecordings).mockResolvedValue([
      recording({
        id: 'orphan',
        user_id: null,
        season_id: null,
        header: { schema_version: 1, environment: 'flappy_bird' },
      }),
    ])
    await renderPage()

    const row = (await screen.findByRole('link', { name: 'orphan' })).closest('tr') as HTMLElement
    // Owner, Season, and Players all fall back to the em dash.
    expect(within(row).getAllByText('—').length).toBeGreaterThanOrEqual(3)
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
    expect(within(row).getByText(/Submitted agent 1/)).toBeInTheDocument()
    expect(within(row).queryByText('maya-fledgling')).toBeNull()
    // The page leans on the public scope (which includes play-open seasons), not the operator path.
    expect(vi.mocked(listSeasons)).toHaveBeenCalledWith('flappy_bird', { includeUnreleased: false })
  })

  it('re-sorts by owner when the Owner header is clicked', async () => {
    vi.mocked(listRecordings).mockResolvedValue([
      recording({ id: 'rec-a', user_id: 'zoe' }),
      recording({ id: 'rec-b', user_id: 'amy' }),
    ])
    await renderPage()
    await screen.findByRole('link', { name: 'rec-a' })

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
