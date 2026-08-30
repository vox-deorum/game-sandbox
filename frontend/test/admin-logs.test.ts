import { fireEvent, screen, waitFor } from '@testing-library/vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AdminLogsResponse } from '../src/api/client.js'
import { formatLogTime } from '../src/lib/format.js'
import { signedInMe } from './helpers/me.js'
import { memoryRouter, renderWithMe } from './helpers/render.js'

vi.mock('../src/api/client.js', () => ({ getMe: vi.fn(), getAdminLogs: vi.fn() }))

import { getAdminLogs, getMe } from '../src/api/client.js'
import AdminLogsPage from '../src/pages/AdminLogsPage.vue'

const PATH = '/admin/logs'

function response(overrides: Partial<AdminLogsResponse> = {}): AdminLogsResponse {
  return {
    boot_id: 'boot-1',
    entries: [
      {
        seq: 1,
        time: '2026-08-29T01:02:03.000Z',
        level: 'warn',
        source: 'http',
        message: 'request failed',
      },
    ],
    oldest_seq: 1,
    latest_seq: 1,
    history_truncated: false,
    retained_count: 1,
    retained_bytes: 512,
    sources: ['http', 'session'],
    ...overrides,
  }
}

async function renderPage() {
  const router = memoryRouter([{ path: PATH, component: AdminLogsPage }])
  router.push(PATH)
  await router.isReady()
  return renderWithMe(router)
}

describe('AdminLogsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getMe).mockResolvedValue(signedInMe('admin-1', 'admin'))
    vi.mocked(getAdminLogs).mockResolvedValue(response())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('gates the page for non-operators', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('user-1', 'normal'))
    await renderPage()

    expect(await screen.findByText(/limited to operators/)).toBeInTheDocument()
    expect(getAdminLogs).not.toHaveBeenCalled()
  })

  it('renders log rows, text-bearing severity badges, source, and retention summary', async () => {
    await renderPage()

    expect(await screen.findByText('request failed')).toBeInTheDocument()
    // The timestamp column renders the shared compact local clock time, not the wire ISO string.
    expect(
      screen.getByText(formatLogTime(Date.parse('2026-08-29T01:02:03.000Z'))),
    ).toBeInTheDocument()
    expect(screen.getByText('warn')).toBeInTheDocument()
    expect(screen.getAllByText('http')).toHaveLength(2)
    expect(screen.getByText('1 shown from 1 retained (512 B)')).toBeInTheDocument()
    expect(screen.getByText(/History resets when the process restarts/)).toBeInTheDocument()
  })

  it('replaces the snapshot after a debounced search filter', async () => {
    vi.useFakeTimers()
    vi.mocked(getAdminLogs).mockResolvedValueOnce(response())
    vi.mocked(getAdminLogs).mockResolvedValueOnce(
      response({
        entries: [
          {
            seq: 2,
            time: '2026-08-29T01:02:04.000Z',
            level: 'error',
            source: 'session',
            message: 'session stopped',
          },
        ],
        latest_seq: 2,
      }),
    )
    await renderPage()
    await vi.advanceTimersByTimeAsync(0)
    await screen.findByText('request failed')

    await fireEvent.update(screen.getByLabelText('Search logs'), 'stopped')
    await vi.advanceTimersByTimeAsync(249)
    expect(getAdminLogs).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)

    await waitFor(() => expect(screen.getByText('session stopped')).toBeInTheDocument())
    expect(getAdminLogs).toHaveBeenLastCalledWith({ q: 'stopped' }, expect.any(Object))
    expect(screen.queryByText('request failed')).toBeNull()
  })

  it('commits a pending search when a level filter replaces the snapshot', async () => {
    vi.useFakeTimers()
    vi.mocked(getAdminLogs).mockResolvedValueOnce(response())
    vi.mocked(getAdminLogs).mockResolvedValueOnce(
      response({
        entries: [
          {
            seq: 2,
            time: '2026-08-29T01:02:04.000Z',
            level: 'error',
            source: 'session',
            message: 'session stopped',
          },
        ],
        latest_seq: 2,
      }),
    )
    await renderPage()
    await vi.advanceTimersByTimeAsync(0)
    await screen.findByText('request failed')

    await fireEvent.update(screen.getByLabelText('Search logs'), 'stopped')
    await fireEvent.click(screen.getByRole('tab', { name: 'Errors' }))

    await waitFor(() => expect(screen.getByText('session stopped')).toBeInTheDocument())
    expect(getAdminLogs).toHaveBeenLastCalledWith(
      { level: 'error', q: 'stopped' },
      expect.any(Object),
    )
    await vi.advanceTimersByTimeAsync(250)
    expect(getAdminLogs).toHaveBeenCalledTimes(2)
  })

  it('uses the tail cursor after clear and does not restore old retained rows', async () => {
    vi.useFakeTimers()
    vi.mocked(getAdminLogs).mockResolvedValueOnce(response({ latest_seq: 4, retained_count: 4 }))
    vi.mocked(getAdminLogs).mockResolvedValueOnce(
      response({ entries: [], oldest_seq: 2, latest_seq: 4, retained_count: 3 }),
    )
    await renderPage()
    await vi.advanceTimersByTimeAsync(0)
    await screen.findByText('request failed')

    await fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.queryByText('request failed')).toBeNull()
    await vi.advanceTimersByTimeAsync(2_000)

    await waitFor(() => expect(getAdminLogs).toHaveBeenCalledTimes(2))
    expect(getAdminLogs).toHaveBeenLastCalledWith({ afterSeq: 4, q: '' }, expect.any(Object))
    expect(screen.queryByText('request failed')).toBeNull()
  })

  it('keeps the local clear baseline when a filter requests a new snapshot', async () => {
    vi.useFakeTimers()
    vi.mocked(getAdminLogs).mockResolvedValueOnce(response({ latest_seq: 4, retained_count: 4 }))
    vi.mocked(getAdminLogs).mockResolvedValueOnce(
      response({ entries: [], oldest_seq: 1, latest_seq: 4, retained_count: 4 }),
    )
    await renderPage()
    await vi.advanceTimersByTimeAsync(0)
    await screen.findByText('request failed')

    await fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    await fireEvent.click(screen.getByRole('tab', { name: 'Errors' }))

    await waitFor(() => expect(getAdminLogs).toHaveBeenCalledTimes(2))
    expect(getAdminLogs).toHaveBeenLastCalledWith(
      { afterSeq: 4, level: 'error', q: '' },
      expect.any(Object),
    )
    expect(screen.queryByText('request failed')).toBeNull()
  })

  it('pauses by aborting the current poll and resumes with an immediate tail', async () => {
    vi.useFakeTimers()
    await renderPage()
    await vi.advanceTimersByTimeAsync(0)
    await screen.findByText('request failed')

    await fireEvent.click(screen.getByRole('button', { name: 'Pause live updates' }))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(getAdminLogs).toHaveBeenCalledTimes(1)

    await fireEvent.click(screen.getByRole('button', { name: 'Resume live updates' }))
    await waitFor(() => expect(getAdminLogs).toHaveBeenCalledTimes(2))
    expect(getAdminLogs).toHaveBeenLastCalledWith({ afterSeq: 1, q: '' }, expect.any(Object))
  })

  it('aborts an in-flight tail and ignores its stale response when paused', async () => {
    vi.useFakeTimers()
    let resolveTail: (value: AdminLogsResponse) => void = () => undefined
    let tailSignal: AbortSignal | undefined
    vi.mocked(getAdminLogs).mockResolvedValueOnce(response())
    vi.mocked(getAdminLogs).mockImplementationOnce(
      (_params, options) =>
        new Promise<AdminLogsResponse>((resolve) => {
          tailSignal = options?.signal
          resolveTail = resolve
        }),
    )
    await renderPage()
    await vi.advanceTimersByTimeAsync(0)
    await screen.findByText('request failed')

    await vi.advanceTimersByTimeAsync(2_000)
    await waitFor(() => expect(getAdminLogs).toHaveBeenCalledTimes(2))
    expect(tailSignal?.aborted).toBe(false)

    await fireEvent.click(screen.getByRole('button', { name: 'Pause live updates' }))
    expect(tailSignal?.aborted).toBe(true)

    resolveTail(
      response({
        entries: [
          {
            seq: 2,
            time: '2026-08-29T01:02:04.000Z',
            level: 'error',
            source: 'session',
            message: 'stale tail entry',
          },
        ],
        latest_seq: 2,
      }),
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(screen.getByText('request failed')).toBeInTheDocument()
    expect(screen.queryByText('stale tail entry')).toBeNull()
  })

  it('replaces all state when the backend boot changes', async () => {
    vi.useFakeTimers()
    vi.mocked(getAdminLogs).mockResolvedValueOnce(
      response({ retained_count: 7, retained_bytes: 7_168 }),
    )
    vi.mocked(getAdminLogs).mockResolvedValueOnce(
      response({ retained_count: 7, retained_bytes: 7_168 }),
    )
    vi.mocked(getAdminLogs).mockResolvedValueOnce(
      response({
        boot_id: 'boot-2',
        latest_seq: 1,
        retained_count: 1,
        retained_bytes: 128,
        sources: ['main'],
      }),
    )
    vi.mocked(getAdminLogs).mockRejectedValueOnce(new Error('new boot offline'))
    await renderPage()
    await vi.advanceTimersByTimeAsync(0)
    await screen.findByText('request failed')

    await fireEvent.update(screen.getByLabelText('Log source'), 'http')
    await waitFor(() => expect(getAdminLogs).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(2_000)

    expect(await screen.findByText('new boot offline')).toBeInTheDocument()
    expect(screen.getByLabelText('Log source')).toHaveValue('')
    expect(screen.queryByText(/shown from/)).toBeNull()
    expect(screen.queryByText('request failed')).toBeNull()
  })

  it('prunes evicted rows and announces a history gap after a truncated tail', async () => {
    vi.useFakeTimers()
    vi.mocked(getAdminLogs).mockResolvedValueOnce(
      response({
        entries: [
          {
            seq: 1,
            time: '2026-08-29T01:02:03.000Z',
            level: 'warn',
            source: 'http',
            message: 'evicted row',
          },
          {
            seq: 2,
            time: '2026-08-29T01:02:04.000Z',
            level: 'info',
            source: 'session',
            message: 'retained row',
          },
        ],
        latest_seq: 2,
        retained_count: 2,
      }),
    )
    vi.mocked(getAdminLogs).mockResolvedValueOnce(
      response({
        entries: [
          {
            seq: 3,
            time: '2026-08-29T01:02:05.000Z',
            level: 'warn',
            source: 'http',
            message: 'new row',
          },
        ],
        oldest_seq: 2,
        latest_seq: 3,
        history_truncated: true,
        retained_count: 2,
      }),
    )
    await renderPage()
    await vi.advanceTimersByTimeAsync(0)
    await screen.findByText('evicted row')

    await vi.advanceTimersByTimeAsync(2_000)

    expect(
      await screen.findByText(/Earlier matching entries are no longer retained/),
    ).toBeInTheDocument()
    expect(screen.queryByText('evicted row')).toBeNull()
    expect(screen.getByText('retained row')).toBeInTheDocument()
    expect(screen.getByText('new row')).toBeInTheDocument()
  })

  it('retains rows through tail failures and shows an initial retry affordance only before success', async () => {
    vi.mocked(getAdminLogs).mockRejectedValueOnce(new Error('offline'))
    await renderPage()
    expect(await screen.findByText('offline')).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(getAdminLogs).toHaveBeenCalledTimes(2))

    vi.mocked(getAdminLogs).mockRejectedValueOnce(new Error('tail offline'))
    await new Promise((resolve) => setTimeout(resolve, 2_050))
    expect(await screen.findByText('tail offline')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })
})
