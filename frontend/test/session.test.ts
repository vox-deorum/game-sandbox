import { fireEvent, screen, waitFor } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import type { SessionSocketHandlers } from '../src/api/socket.js'
import type { RendererContext } from '../src/renderers/types.js'
import { flappyHeader, flappyMeta, flappyState, recordingText } from './helpers/fixtures.js'
import { memoryRouter, renderWithMe } from './helpers/render.js'

const META = flappyMeta({ description: '' })
const HEADER = flappyHeader()

// A controllable SessionSocket double: it captures the handlers so the test can drive frames, and
// records the commands the page sends.
let handlers: SessionSocketHandlers
let sent: unknown[]
vi.mock('../src/api/socket.js', () => ({
  SessionSocket: class {
    constructor(_path: string, h: SessionSocketHandlers) {
      handlers = h
    }
    connect(): void {}
    send(command: unknown): void {
      sent.push(command)
    }
    close(): void {}
  },
}))

// A fake renderer that records what it was mounted with and the states it drew.
let mountCtx: RendererContext | null
let drawn: unknown[]
vi.mock('../src/renderers/registry.js', () => ({
  getRenderer: () => ({
    mount: (ctx: RendererContext) => {
      mountCtx = ctx
      return { render: (s: unknown) => drawn.push(s), destroy: () => {} }
    },
    thumbnail: '',
    internalSize: { width: 288, height: 512 },
    aspectRatio: 288 / 512,
  }),
}))

vi.mock('../src/api/client.js', () => ({
  getSession: vi.fn(),
  getEnvironments: vi.fn(async () => [META]),
  getRecording: vi.fn(),
  listRecordings: vi.fn(async () => []),
  listSeasons: vi.fn(async () => []),
  getMe: vi.fn(),
  pinRecording: vi.fn(async () => ({ ok: true })),
  unpinRecording: vi.fn(async () => ({ ok: true })),
  // The end-of-session rating panel self-fetches on mount; default it to not-rateable so these
  // session-chrome tests render no panel. The rating UI has its own suite.
  getSessionRatings: vi.fn(async () => ({ ok: false, reason: 'not_rateable' })),
  submitRatings: vi.fn(),
}))

import {
  getMe,
  getRecording,
  getSession,
  getSessionRatings,
  listRecordings,
  listSeasons,
} from '../src/api/client.js'
import SessionPage from '../src/pages/SessionPage.vue'

function ownerRow() {
  return {
    id: 's1',
    user_id: 'dev-user',
    env_id: 'flappy_bird',
    mode: 'human' as const,
    status: 'starting' as const,
    termination_reason: null,
    recording_id: 'flappy_bird-s1',
    season_id: 'flappy_bird-iter-1',
    created_at: '2026-06-11T00:00:00.000Z',
    ended_at: null,
  }
}

/** A watch run: a scripted (non-human) session a viewer streams with no controls. */
function scriptedRow() {
  return { ...ownerRow(), user_id: 'someone-else', mode: 'scripted' as const }
}

function endedOwnerRow() {
  return {
    ...ownerRow(),
    status: 'ended' as const,
    termination_reason: 'terminated' as const,
    ended_at: '2026-06-11T00:00:02.000Z',
  }
}

/** The recorded states the ended-session view hydrates from (score 20 + tick, as the suite asserts). */
function sessionRecording(): string {
  return recordingText([flappyState(0, 20), flappyState(1, 21), flappyState(2, 22)], {
    seed: HEADER.seed,
  })
}

async function renderSession() {
  const router = memoryRouter([
    // Stubs so the ExperimentTabs strip's links (game, leaderboards, submissions) resolve.
    { path: '/', component: { template: '<div />' } },
    { path: '/environments/:envId', component: { template: '<div />' } },
    { path: '/environments/:envId/leaderboards', component: { template: '<div />' } },
    { path: '/environments/:envId/replays', component: { template: '<div />' } },
    { path: '/environments/:envId/agents/:ownerId', component: { template: '<div />' } },
    { path: '/sessions/:id', component: SessionPage },
    { path: '/replays/:id', component: { template: '<div>replay</div>' } },
  ])
  router.push('/sessions/s1')
  await router.isReady()
  renderWithMe(router)
}

/** Wait until the page has connected its socket and we hold its handlers. */
async function waitForHandlers(): Promise<void> {
  await waitFor(() => expect(handlers).toBeDefined())
}

describe('SessionPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    handlers = undefined as unknown as SessionSocketHandlers
    sent = []
    mountCtx = null
    drawn = []
    vi.mocked(getRecording).mockResolvedValue(sessionRecording())
    vi.mocked(listRecordings).mockResolvedValue([])
    vi.mocked(listSeasons).mockResolvedValue([])
    vi.mocked(getSessionRatings).mockResolvedValue({ ok: false, reason: 'not_rateable' })
  })

  it('mounts the renderer for the owner of a human session and wires input', async () => {
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'dev-user',
      allowlisted: true,
      is_operator: false,
    })
    vi.mocked(getSession).mockResolvedValue(ownerRow())
    await renderSession()
    await waitForHandlers()

    handlers.onHeader(HEADER)
    handlers.onState({
      schema_version: 1,
      tick: 0,
      agents: {},
      timing: { started_at: 0, duration_ms: 0 },
    })

    expect(mountCtx?.controlledSlots).toEqual(['player_0'])
    expect(drawn).toHaveLength(1)

    // The owner gets a live sendAction that the page forwards as an input command.
    mountCtx?.sendAction?.('player_0', 1)
    expect(sent).toContainEqual({ kind: 'input', slot: 'player_0', action: 1 })
  })

  it('reflects pause/resume echoes and sends the toggle command', async () => {
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'dev-user',
      allowlisted: true,
      is_operator: false,
    })
    vi.mocked(getSession).mockResolvedValue(ownerRow())
    await renderSession()
    await waitForHandlers()
    handlers.onHeader(HEADER)
    handlers.onSessionStatus?.('running')

    await fireEvent.click(await screen.findByRole('button', { name: 'Pause' }))
    expect(sent).toContainEqual({ kind: 'pause' })

    // The overlay (and the status label) reflect the echo, not the click.
    handlers.onPause?.()
    expect((await screen.findAllByText('Paused')).length).toBeGreaterThan(0)
    handlers.onResume?.()
    await waitFor(() => expect(screen.queryByText('Paused')).toBeNull())
  })

  it('shows the end card with the result facts and a replay link', async () => {
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'dev-user',
      allowlisted: true,
      is_operator: false,
    })
    vi.mocked(getSession).mockResolvedValue(ownerRow())
    await renderSession()
    await waitForHandlers()
    handlers.onHeader(HEADER)
    handlers.onResult?.({ ticks: 42, reason: 'terminated', scores: { player_0: 7 } })
    handlers.onSessionStatus?.('ended', 'terminated')

    expect(await screen.findByText('Game over')).toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open replay' })).toHaveAttribute(
      'href',
      '/replays/flappy_bird-s1',
    )
  })

  it('reveals the rating panel above the canvas only after the session ends', async () => {
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'viewer',
      allowlisted: true,
      is_operator: false,
    })
    vi.mocked(getSession).mockResolvedValue(ownerRow())
    vi.mocked(getSessionRatings).mockResolvedValue({
      ok: true,
      ratings: {
        session_id: 's1',
        season_id: 'flappy_bird-iter-1',
        read_only: false,
        season_prompt: 'Judge survival.',
        agents: [
          {
            agent: { kind: 'submission', submission_id: 'sub-1' },
            display_name: 'Submitted agent 1',
            is_own: false,
            author_prompt: 'Judge smoothness.',
            your_rating: null,
          },
        ],
      },
    })
    await renderSession()
    await waitForHandlers()
    expect(screen.queryByText('Rate the agents')).toBeNull()

    handlers.onHeader(HEADER)
    handlers.onResult?.({ ticks: 1, reason: 'stopped', scores: { player_0: 1 } })
    handlers.onSessionStatus?.('ended', 'stopped')

    const panel = await screen.findByTestId('ratings-reveal')
    const canvasStage = document.querySelector('.stage')
    expect(canvasStage).not.toBeNull()
    expect(
      panel.compareDocumentPosition(canvasStage as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0)
    expect(screen.getByText('Judge survival.')).toBeInTheDocument()
    expect(screen.getByText('Judge smoothness.')).toBeInTheDocument()
  })

  it('masks playable submitted-agent attribution for non-operators', async () => {
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'viewer',
      allowlisted: true,
      is_operator: false,
    })
    vi.mocked(getSession).mockResolvedValue(scriptedRow())
    vi.mocked(listSeasons).mockResolvedValue([
      {
        id: 'flappy_bird-iter-1',
        env_id: 'flappy_bird',
        submission_status: 'closed',
        play_status: 'open',
        release_status: 'unreleased',
        label: 'Playground',
        created_at: '2026-06-11T00:00:00.000Z',
        released_at: null,
        submission_count: 1,
        session_count: 1,
      },
    ])
    await renderSession()
    await waitForHandlers()
    handlers.onHeader(
      flappyHeader({
        players: {
          player_0: {
            kind: 'agent',
            label: "maya-fledgling's agent",
            user: 'maya-fledgling',
            submission_id: 'sub-maya',
          },
        },
      }),
    )
    expect(await screen.findByText('Submitted agent')).toBeInTheDocument()
    expect(screen.queryByText("maya-fledgling's agent")).toBeNull()
  })

  it('reveals submitted-agent attribution after public play closes', async () => {
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'viewer',
      allowlisted: true,
      is_operator: false,
    })
    vi.mocked(getSession).mockResolvedValue(scriptedRow())
    vi.mocked(listSeasons).mockResolvedValue([
      {
        id: 'flappy_bird-iter-1',
        env_id: 'flappy_bird',
        submission_status: 'closed',
        play_status: 'closed',
        release_status: 'released',
        label: 'Playground',
        created_at: '2026-06-11T00:00:00.000Z',
        released_at: '2026-06-12T00:00:00.000Z',
        submission_count: 1,
        session_count: 1,
      },
    ])
    await renderSession()
    await waitForHandlers()
    handlers.onHeader(
      flappyHeader({
        players: {
          player_0: {
            kind: 'agent',
            label: "maya-fledgling's agent",
            user: 'maya-fledgling',
            submission_id: 'sub-maya',
          },
        },
      }),
    )
    expect(await screen.findByText("maya-fledgling's agent")).toBeInTheDocument()
  })

  it('returns to an ended session without opening a socket and shows recording metadata', async () => {
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'dev-user',
      allowlisted: true,
      is_operator: false,
    })
    vi.mocked(getSession).mockResolvedValue(endedOwnerRow())
    vi.mocked(listRecordings).mockResolvedValue([
      {
        id: 'flappy_bird-s1',
        header: HEADER,
        user_id: 'dev-user',
        created_at: '2026-06-11T00:00:00.000Z',
        pinned: true,
        termination_reason: 'terminated',
        season_id: null,
      },
    ])
    await renderSession()

    expect(await screen.findByText('Game over')).toBeInTheDocument()
    expect(handlers).toBeUndefined()
    // Mode/owner are gone; the run facts now sit inline in the status row as Score/Ticks/Started.
    expect(await screen.findByText('Score')).toBeInTheDocument()
    expect(screen.getByText('22')).toBeInTheDocument()
    // Pin state is conveyed by the button alone now, not a duplicate metadata row.
    expect(await screen.findByRole('button', { name: 'Pinned ✓' })).toBeInTheDocument()
    expect(mountCtx?.controlledSlots).toEqual([])
    expect(mountCtx?.sendAction).toBeUndefined()
    expect(drawn.at(-1)).toMatchObject({ tick: 2 })
  })

  it('gives a spectator no controls and no input', async () => {
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'someone-else',
      allowlisted: true,
      is_operator: false,
    })
    vi.mocked(getSession).mockResolvedValue(ownerRow())
    await renderSession()
    await waitForHandlers()
    handlers.onHeader(HEADER)
    handlers.onSessionStatus?.('running')

    expect(mountCtx?.controlledSlots).toEqual([])
    expect(mountCtx?.sendAction).toBeUndefined()
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('buffers a watch run through the jitter buffer and reveals game over only after it drains', async () => {
    vi.mocked(getMe).mockResolvedValue({ user_id: 'viewer', allowlisted: true, is_operator: false })
    vi.mocked(getSession).mockResolvedValue(scriptedRow())
    await renderSession()
    await waitForHandlers()

    vi.useFakeTimers()
    try {
      handlers.onHeader(HEADER)
      // Two frames sit below the lead (150 ms / 50 ms cadence = 3), so playout has not begun: even
      // after time passes nothing draws — the buffer is still filling to absorb network jitter.
      handlers.onState(flappyState(0, 1))
      handlers.onState(flappyState(1, 2))
      vi.advanceTimersByTime(200)
      await nextTick()
      expect(drawn).toHaveLength(0)

      // A third frame fills the lead; playout begins and plays one buffered frame per cadence tick.
      handlers.onState(flappyState(2, 3))
      vi.advanceTimersByTime(50)
      await nextTick()
      expect(drawn).toHaveLength(1)
      expect(screen.queryByText('Game over')).toBeNull()

      // The stream ends while frames remain buffered; game over stays hidden until they drain.
      handlers.onResult?.({ ticks: 42, reason: 'terminated', scores: { player_0: 7 } })
      handlers.onSessionStatus?.('ended', 'terminated')
      vi.advanceTimersByTime(50)
      await nextTick()
      expect(drawn).toHaveLength(2)
      expect(screen.queryByText('Game over')).toBeNull()

      // The last frame plays and only then is game over revealed, with the held result.
      vi.advanceTimersByTime(50)
      await nextTick()
      expect(drawn).toHaveLength(3)
      expect(screen.getByText('Game over')).toBeInTheDocument()
      expect(screen.getByText('7')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows a waiting indicator when the jitter buffer underruns, and clears it when frames resume', async () => {
    vi.mocked(getMe).mockResolvedValue({ user_id: 'viewer', allowlisted: true, is_operator: false })
    vi.mocked(getSession).mockResolvedValue(scriptedRow())
    await renderSession()
    await waitForHandlers()

    vi.useFakeTimers()
    try {
      handlers.onHeader(HEADER)
      handlers.onSessionStatus?.('running')
      // Fill the lead (3 frames) so playout begins, then drain all three.
      handlers.onState(flappyState(0, 1))
      handlers.onState(flappyState(1, 2))
      handlers.onState(flappyState(2, 3))
      vi.advanceTimersByTime(150)
      await nextTick()
      expect(drawn).toHaveLength(3)
      expect(screen.queryByText('Waiting…')).toBeNull()

      // The next tick finds the buffer empty with the stream still live: the indicator appears.
      vi.advanceTimersByTime(50)
      await nextTick()
      expect(screen.getByText('Waiting…')).toBeInTheDocument()

      // A fresh frame arrives and plays on the next tick; the indicator clears.
      handlers.onState(flappyState(3, 4))
      vi.advanceTimersByTime(50)
      await nextTick()
      expect(drawn).toHaveLength(4)
      expect(screen.queryByText('Waiting…')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows "No such session" when the row is missing', async () => {
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'dev-user',
      allowlisted: true,
      is_operator: false,
    })
    vi.mocked(getSession).mockResolvedValue(undefined)
    await renderSession()
    expect(await screen.findByText('No such session.')).toBeInTheDocument()
  })
})
