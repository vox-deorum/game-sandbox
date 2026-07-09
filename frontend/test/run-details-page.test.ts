import { screen, waitFor } from '@testing-library/vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RunView } from '../src/api/client.js'
import { signedInMe } from './helpers/me.js'
import { memoryRouter, renderWithMe } from './helpers/render.js'

vi.mock('../src/api/client.js', () => ({
  getMe: vi.fn(),
  getRun: vi.fn(),
  runLogWsPath: (seasonId: string, runId: string) =>
    `/api/admin/seasons/${seasonId}/runs/${runId}/logs/ws`,
}))

import { getMe, getRun } from '../src/api/client.js'
import RunDetailsPage from '../src/pages/RunDetailsPage.vue'

const PATH = '/environments/flappy_bird/admin/seasons/iter-1/runs/run-1'

function runView(overrides: Partial<RunView> = {}): RunView {
  return {
    id: 'run-1',
    season_id: 'iter-1',
    requested_by: 'dev-user',
    config_snapshot: {
      deps_version: 1,
      matches: [{ slots: ['submission'], seeds: [0], games: 1 }],
    },
    submission_snapshot: [],
    status: 'running',
    started_at: '2026-06-12T00:00:00Z',
    ended_at: null,
    error: null,
    games: [
      {
        id: 'g1',
        run_id: 'run-1',
        match_index: 0,
        game_index: 0,
        seed: 0,
        slots: [{ kind: 'submission', submission_id: 's1', user_id: 'alice' }],
        status: 'running',
        recording_id: 'rec-9',
        started_at: null,
        ended_at: null,
        error: null,
      },
      {
        id: 'g2',
        run_id: 'run-1',
        match_index: 0,
        game_index: 1,
        seed: 1,
        slots: [{ kind: 'builtin-naive' }],
        status: 'pending',
        recording_id: null,
        started_at: null,
        ended_at: null,
        error: null,
      },
    ],
    ...overrides,
  }
}

/** A fake WebSocket capturing the instances so a test can drive incoming frames. */
class FakeWS {
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {
    sockets.push(this)
  }
  close(): void {
    this.onclose?.()
  }
}
let sockets: FakeWS[] = []

async function renderPage() {
  const router = memoryRouter([
    { path: '/environments/:envId/admin', component: { template: '<div />' } },
    {
      path: '/environments/:envId/admin/seasons/:seasonId/runs/:runId',
      component: RunDetailsPage,
    },
    { path: '/replays/:id', component: { template: '<div />' } },
  ])
  router.push(PATH)
  await router.isReady()
  return renderWithMe(router)
}

describe('RunDetailsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sockets = []
    vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket)
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'admin'))
    vi.mocked(getRun).mockResolvedValue(runView())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders an access notice for a non-operator', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('carol', 'normal'))
    await renderPage()
    expect(await screen.findByText(/limited to operators/)).toBeInTheDocument()
    expect(vi.mocked(getRun)).not.toHaveBeenCalled()
  })

  it('renders the games table with per-game status and replay links', async () => {
    await renderPage()
    expect(await screen.findByText('m0 · g0 · seed 0')).toBeInTheDocument()
    // A game with a recording links to its replay; one without shows no link.
    const replay = screen.getByRole('link', { name: 'Replay' })
    expect(replay).toHaveAttribute('href', '/replays/rec-9')
    expect(screen.getAllByRole('link', { name: 'Replay' })).toHaveLength(1)
    // No user_name on either game's slots, so the players summary falls back to the stable id (the
    // second game's lone slot is the ownerless Naive baseline, in its own row).
    const playersCell = screen.getByText('alice')
    expect(playersCell).toBeInTheDocument()
    // GamesTable never applies blind masking (admin run games), so the cell also carries the
    // submission's stable id as a tooltip.
    expect(playersCell).toHaveAttribute('title', 'alice')
    const naiveCell = screen.getByText('Naive')
    expect(naiveCell).toBeInTheDocument()
    // An all-Naive seat list has no submission id to show, so its cell carries no tooltip.
    expect(naiveCell).not.toHaveAttribute('title')
    // The requester metadata falls back to the stable id too, kept as a tooltip.
    const requester = screen.getByText('dev-user')
    expect(requester).toHaveAttribute('title', 'dev-user')
  })

  it('prefers user_name over the stable id in the games table and the requester metadata', async () => {
    vi.mocked(getRun).mockResolvedValue(
      runView({
        requested_by: 'dev-user',
        requested_by_name: 'Dev User',
        games: [
          {
            id: 'g1',
            run_id: 'run-1',
            match_index: 0,
            game_index: 0,
            seed: 0,
            slots: [
              {
                kind: 'submission',
                submission_id: 's1',
                user_id: 'alice',
                user_name: 'Alice Nguyen',
              },
            ],
            status: 'running',
            recording_id: 'rec-9',
            started_at: null,
            ended_at: null,
            error: null,
          },
        ],
      }),
    )
    await renderPage()

    const playersCell = await screen.findByText('Alice Nguyen')
    expect(screen.queryByText('alice', { exact: true })).toBeNull()
    // The display name shows, but the stable id still rides as the cell's tooltip.
    expect(playersCell).toHaveAttribute('title', 'alice')
    const requester = screen.getByText('Dev User')
    expect(requester).toHaveAttribute('title', 'dev-user')
    expect(screen.queryByText('dev-user', { exact: true })).toBeNull()
  })

  it('opens the live stream for an in-progress run and renders streamed lines', async () => {
    await renderPage()
    await waitFor(() => expect(sockets.length).toBe(1))
    const ws = sockets[0] as FakeWS
    expect(ws.url).toContain('/api/admin/seasons/iter-1/runs/run-1/logs/ws')

    ws.onmessage?.({
      data: JSON.stringify({
        type: 'log',
        match_index: 0,
        game_index: 0,
        ts: Date.UTC(2026, 5, 12, 1, 2, 3),
        level: 'warning',
        line: 'container started',
      }),
    })
    expect(await screen.findByText(/container started/)).toBeInTheDocument()
    // The line carries its severity through to the level column. The badge passes the level verbatim
    // (capitalization is a CSS display effect), so the DOM text stays the lowercase level code.
    expect(screen.getByText('warning')).toBeInTheDocument()
  })

  it('opens no stream if it unmounts before the run loads', async () => {
    // Hold getRun in flight so the page is mid-load when it tears down.
    let resolveRun: ((run: RunView) => void) | undefined
    vi.mocked(getRun).mockReturnValue(
      new Promise<RunView>((resolve) => {
        resolveRun = resolve
      }),
    )
    const { unmount } = await renderPage()
    await waitFor(() => expect(vi.mocked(getRun)).toHaveBeenCalled())

    // Unmount, then let the in-flight load resolve: it must not open a socket behind the gone page.
    unmount()
    resolveRun?.(runView())
    await Promise.resolve()
    expect(sockets.length).toBe(0)
  })

  it('opens no stream for a run that is already terminal at load', async () => {
    vi.mocked(getRun).mockResolvedValue(
      runView({ status: 'completed', ended_at: '2026-06-12T00:05:00Z' }),
    )
    await renderPage()
    // The persisted view renders without a socket; the header badge shows the terminal status.
    expect(await screen.findByText('completed')).toBeInTheDocument()
    expect(sockets.length).toBe(0)
  })
})
