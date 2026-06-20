import { fireEvent, screen, waitFor } from '@testing-library/vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AdminSeasonView, Board, RunView, SeasonView } from '../src/api/client.js'
import { flappyMeta } from './helpers/fixtures.js'
import { memoryRouter, renderWithMe } from './helpers/render.js'

vi.mock('../src/api/client.js', () => ({
  getMe: vi.fn(),
  getEnvironments: vi.fn(),
  listAdminSeasons: vi.fn(),
  getAdminSeason: vi.fn(),
  declareSeason: vi.fn(),
  renameSeason: vi.fn(),
  configureSeason: vi.fn(),
  setSeasonRatingPrompt: vi.fn(),
  openSubmissions: vi.fn(),
  closeSubmissions: vi.fn(),
  openPlay: vi.fn(),
  closePlay: vi.fn(),
  releaseSeason: vi.fn(),
  unreleaseSeason: vi.fn(),
  triggerRun: vi.fn(),
  cancelRun: vi.fn(),
  runLogWsPath: (seasonId: string, runId: string) =>
    `/api/admin/seasons/${seasonId}/runs/${runId}/logs/ws`,
}))

import {
  configureSeason,
  declareSeason,
  getAdminSeason,
  getEnvironments,
  getMe,
  listAdminSeasons,
  openPlay,
  openSubmissions,
  releaseSeason,
  renameSeason,
  setSeasonRatingPrompt,
  triggerRun,
} from '../src/api/client.js'
import AdminConsolePage from '../src/pages/AdminConsolePage.vue'

function season(overrides: Partial<SeasonView> = {}): SeasonView {
  return {
    id: 'iter-1',
    env_id: 'flappy_bird',
    submission_status: 'closed',
    play_status: 'closed',
    release_status: 'unreleased',
    label: 'Week 1',
    config: { deps_version: 1, matches: [{ slots: ['submission'], seeds: [0], games: 1 }] },
    rating_prompt: null,
    created_at: '2026-06-10T00:00:00Z',
    released_at: null,
    ...overrides,
  }
}

function emptyBoard(): Board {
  return { automated: [], human: [] }
}

function adminView(overrides: Partial<AdminSeasonView> = {}): AdminSeasonView {
  return {
    season: season(),
    latest_run: null,
    board: emptyBoard(),
    ...overrides,
  }
}

function runningRun(): RunView {
  return {
    id: 'run-1',
    season_id: 'iter-1',
    requested_by: 'dev-user',
    config_snapshot: {
      deps_version: 1,
      matches: [{ slots: ['submission'], seeds: [0], games: 1 }],
    },
    submission_snapshot: [{ kind: 'submission', submission_id: 's1', user_id: 'alice' }],
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
        status: 'pending',
        recording_id: null,
        started_at: null,
        ended_at: null,
        error: null,
      },
    ],
  }
}

async function renderConsole() {
  const router = memoryRouter([
    { path: '/', component: { template: '<div />' } },
    { path: '/environments/:envId', component: { template: '<div />' } },
    { path: '/environments/:envId/agents/:ownerId', component: { template: '<div />' } },
    { path: '/environments/:envId/leaderboards/:seasonId?', component: { template: '<div />' } },
    { path: '/replays/:id', component: { template: '<div />' } },
    { path: '/environments/:envId/admin', component: AdminConsolePage },
  ])
  router.push('/environments/flappy_bird/admin')
  await router.isReady()
  return renderWithMe(router)
}

describe('AdminConsolePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getEnvironments).mockResolvedValue([flappyMeta()])
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'dev-user',
      allowlisted: true,
      is_operator: true,
    })
    vi.mocked(listAdminSeasons).mockResolvedValue([season()])
    vi.mocked(getAdminSeason).mockResolvedValue(adminView())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders an access notice for a non-operator', async () => {
    vi.mocked(getMe).mockResolvedValue({ user_id: 'carol', allowlisted: true, is_operator: false })
    await renderConsole()
    expect(await screen.findByText(/limited to operators/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Declare season' })).toBeNull()
  })

  it('renders the console and the selected season for an operator', async () => {
    await renderConsole()
    expect(await screen.findByRole('heading', { name: 'Admin console' })).toBeInTheDocument()
    expect(vi.mocked(getAdminSeason)).toHaveBeenCalledWith('iter-1')
    // The three independent gates each show their current state (await the detail load).
    expect(await screen.findByText('Unreleased')).toBeInTheDocument()
    expect(screen.getByText('Submissions closed')).toBeInTheDocument()
    expect(screen.getByText('Play closed')).toBeInTheDocument()
  })

  it('prefixes an unnamed season exactly once', async () => {
    const unnamed = season({ id: 'abcdef123456', label: null })
    vi.mocked(listAdminSeasons).mockResolvedValue([unnamed])
    vi.mocked(getAdminSeason).mockResolvedValue(adminView({ season: unnamed }))
    await renderConsole()
    expect(await screen.findByRole('heading', { name: 'Season abcdef12' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Season Season/ })).toBeNull()
  })

  it('declares a new season through the admin API', async () => {
    vi.mocked(declareSeason).mockResolvedValue(season({ id: 'iter-2', label: 'Week 2' }))
    await renderConsole()
    await fireEvent.click(await screen.findByRole('button', { name: 'Declare season' }))
    expect(vi.mocked(declareSeason)).toHaveBeenCalledWith('flappy_bird', {})
  })

  it('surfaces the one-open-submission invariant when opening submissions', async () => {
    vi.mocked(openSubmissions).mockResolvedValue({ ok: false, reason: 'open_season_exists' })
    await renderConsole()
    await fireEvent.click(await screen.findByRole('button', { name: 'Open submissions' }))
    expect(await screen.findByText(/already accepting submissions/)).toBeInTheDocument()
  })

  it('surfaces the one-play-open invariant when opening play on an unreleased season', async () => {
    vi.mocked(openPlay).mockResolvedValue({ ok: false, reason: 'open_play_season_exists' })
    await renderConsole()
    await fireEvent.click(await screen.findByRole('button', { name: 'Open play' }))
    expect(await screen.findByText(/already open for public play/)).toBeInTheDocument()
  })

  it('releases the season through the release endpoint', async () => {
    vi.mocked(releaseSeason).mockResolvedValue(season({ release_status: 'released' }))
    await renderConsole()
    await fireEvent.click(await screen.findByRole('button', { name: 'Release' }))
    expect(vi.mocked(releaseSeason)).toHaveBeenCalledWith('iter-1')
  })

  it('renames the selected season through the admin API', async () => {
    vi.mocked(renameSeason).mockResolvedValue({
      ok: true,
      season: season({ label: 'Playground' }),
    })
    // The reload after a successful rename reads back the renamed season.
    vi.mocked(getAdminSeason).mockResolvedValue(
      adminView({ season: season({ label: 'Playground' }) }),
    )
    await renderConsole()
    await fireEvent.click(await screen.findByRole('button', { name: 'Rename' }))
    await fireEvent.update(await screen.findByLabelText('Season name'), 'Playground')
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(vi.mocked(renameSeason)).toHaveBeenCalledWith('iter-1', 'Playground')
    // Rename mode closes and the new name shows, prefixed in the detail heading.
    expect(await screen.findByRole('heading', { name: 'Season Playground' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rename' })).toBeInTheDocument()
  })

  it('refuses to save a match with zero slots', async () => {
    await renderConsole()
    // Remove the match's only slot, then attempt to save.
    await fireEvent.click(await screen.findByRole('button', { name: '×' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }))
    expect(await screen.findByText(/has no slots/)).toBeInTheDocument()
    expect(vi.mocked(configureSeason)).not.toHaveBeenCalled()
  })

  it('prompts the force confirmation when runs exist and re-sends with force', async () => {
    vi.mocked(getAdminSeason).mockResolvedValue(adminView({ latest_run: runningRun() }))
    vi.mocked(configureSeason)
      .mockResolvedValueOnce({ ok: false, reason: 'season_has_runs', message: 'has runs' })
      .mockResolvedValueOnce({ ok: true, season: season() })
    await renderConsole()

    await fireEvent.click(await screen.findByRole('button', { name: 'Save configuration' }))
    // The dialog spells out the deletion before sending force.
    expect(await screen.findByText(/deletes its existing runs and boards/)).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Delete and save' }))

    await waitFor(() => expect(vi.mocked(configureSeason)).toHaveBeenCalledTimes(2))
    expect(vi.mocked(configureSeason).mock.calls[1]?.[2]).toBe(true)
  })

  it('warns that a forced dependency change also deletes submissions when runs exist', async () => {
    vi.mocked(configureSeason).mockResolvedValue({
      ok: false,
      reason: 'season_has_runs',
      message: 'has runs',
    })
    await renderConsole()

    await fireEvent.update(await screen.findByLabelText('Dependency-set version'), '2')
    await fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }))

    expect(await screen.findByText(/deletes this season's submissions/)).toBeInTheDocument()
    expect(screen.getByText(/along with its existing runs and boards/)).toBeInTheDocument()
  })

  it('discards a stale detail response after the operator selects another season', async () => {
    const second = season({ id: 'iter-2', label: 'Week 2' })
    vi.mocked(listAdminSeasons).mockResolvedValue([season(), second])
    await renderConsole()
    expect(await screen.findByRole('heading', { name: 'Season Week 1' })).toBeInTheDocument()

    let resolveWeek1: ((value: AdminSeasonView) => void) | undefined
    let resolveWeek2: ((value: AdminSeasonView) => void) | undefined
    vi.mocked(getAdminSeason).mockImplementation((id) => {
      return new Promise((resolve) => {
        if (id === 'iter-2') {
          resolveWeek2 = resolve
        } else {
          resolveWeek1 = resolve
        }
      })
    })

    await fireEvent.click(screen.getByRole('button', { name: /Week 2/ }))
    await fireEvent.click(screen.getByRole('button', { name: /Week 1/ }))
    resolveWeek1?.(adminView())
    expect(await screen.findByRole('heading', { name: 'Season Week 1' })).toBeInTheDocument()

    resolveWeek2?.(adminView({ season: second }))
    await Promise.resolve()
    expect(screen.queryByRole('heading', { name: 'Season Week 2' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Season Week 1' })).toBeInTheDocument()
  })

  it('saves the season rating prompt and stays editable after a run', async () => {
    vi.mocked(getAdminSeason).mockResolvedValue(adminView({ latest_run: runningRun() }))
    vi.mocked(setSeasonRatingPrompt).mockResolvedValue({
      ok: true,
      season: season({ rating_prompt: 'Judge smoothness' }),
    })
    await renderConsole()

    const textarea = await screen.findByLabelText('Rating prompt')
    await fireEvent.update(textarea, 'Judge smoothness')
    await fireEvent.click(screen.getByRole('button', { name: 'Save prompt' }))
    expect(vi.mocked(setSeasonRatingPrompt)).toHaveBeenCalledWith('iter-1', 'Judge smoothness')
    expect(await screen.findByText('Saved ✓')).toBeInTheDocument()
  })

  it('surfaces run_in_progress and empty_schedule from a trigger', async () => {
    vi.mocked(triggerRun).mockResolvedValue({
      ok: false,
      reason: 'run_in_progress',
      message: 'busy',
    })
    await renderConsole()
    await fireEvent.click(await screen.findByRole('button', { name: 'Run workflow' }))
    expect(await screen.findByText(/already in progress/)).toBeInTheDocument()

    vi.mocked(triggerRun).mockResolvedValue({
      ok: false,
      reason: 'empty_schedule',
      message: 'empty',
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Run workflow' }))
    expect(await screen.findByText(/match design/)).toBeInTheDocument()
  })

  it('disables Run workflow while the match design has unsaved edits', async () => {
    await renderConsole()
    // The seeded config matches the persisted season, so the run trigger starts available.
    expect(await screen.findByRole('button', { name: 'Run workflow' })).toBeEnabled()

    // Add a match without saving: the design now differs from the persisted config.
    await fireEvent.click(screen.getByRole('button', { name: 'Add match' }))

    expect(screen.getByRole('button', { name: 'Run workflow' })).toBeDisabled()
    expect(screen.getByText(/Unsaved changes/)).toBeInTheDocument()
    expect(screen.getByText(/Save the match design before running/)).toBeInTheDocument()
  })

  it('subscribes to the log stream after a trigger and renders streamed lines', async () => {
    // A fake WebSocket capturing the instance so the test can drive incoming frames.
    const sockets: FakeWS[] = []
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
    vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket)

    // Before the trigger there is no run; after it, the reload returns a running run with one game.
    vi.mocked(getAdminSeason)
      .mockResolvedValueOnce(adminView())
      .mockResolvedValue(adminView({ latest_run: runningRun() }))
    vi.mocked(triggerRun).mockResolvedValue({ ok: true, id: 'run-1', status: 'pending' })

    await renderConsole()
    await fireEvent.click(await screen.findByRole('button', { name: 'Run workflow' }))

    // The reload moves the run in-progress, so the panel opens the live stream.
    await waitFor(() => expect(sockets.length).toBe(1))
    const ws = sockets[0] as FakeWS
    expect(ws.url).toContain('/api/admin/seasons/iter-1/runs/run-1/logs/ws')

    ws.onmessage?.({
      data: JSON.stringify({
        type: 'log',
        match_index: 0,
        game_index: 0,
        line: 'container started',
      }),
    })
    expect(await screen.findByText(/container started/)).toBeInTheDocument()
  })

  it('links to the season board once a run has computed one', async () => {
    const board: Board = {
      automated: [
        {
          agent: { kind: 'builtin-naive' },
          mean_score: 5,
          mean_agent_compute_ms: 1,
          failure_count: 0,
          games: 2,
          recording_id: 'rec-1',
        },
      ],
      human: [],
    }
    vi.mocked(getAdminSeason).mockResolvedValue(adminView({ board }))
    await renderConsole()
    const link = await screen.findByRole('link', { name: 'Check leaderboard' })
    expect(link).toHaveAttribute('href', '/environments/flappy_bird/leaderboards/iter-1')
  })

  it('disables the board link before any run has computed a board', async () => {
    await renderConsole()
    expect(await screen.findByRole('button', { name: 'Check leaderboard' })).toBeDisabled()
  })
})
