import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { fireEvent, render, screen, waitFor } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'

import type { SessionSocketHandlers } from '../src/api/socket.js'
import type { RendererContext } from '../src/renderers/types.js'

const META: EnvironmentMeta = {
  env_id: 'flappy_bird',
  display_name: 'Flappy Bird',
  description: '',
  min_slots: 1,
  max_slots: 1,
  human_slots: ['player_0'],
  human_timeout_ms: null,
  recommended_episode_ticks: 1000,
  pace_interval_ms: 50,
  step_limit_ms: 1000,
  episode_limit_ms: 120_000,
  messaging: false,
  message_cap: null,
  llm: false,
  renderer: 'flappy-bird',
}

const HEADER = { schema_version: 1 as const, environment: 'flappy_bird', seed: 0 }

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
  }),
}))

vi.mock('../src/api/client.js', () => ({
  getSession: vi.fn(),
  getEnvironments: vi.fn(async () => [META]),
  getRecording: vi.fn(),
  listRecordings: vi.fn(async () => []),
  getMe: vi.fn(),
  pinRecording: vi.fn(async () => ({ ok: true })),
  unpinRecording: vi.fn(async () => ({ ok: true })),
}))

import { getMe, getRecording, getSession, listRecordings } from '../src/api/client.js'
import { MeProvider } from '../src/me.js'
import SessionPage from '../src/pages/session.vue'

function ownerRow() {
  return {
    id: 's1',
    user_id: 'dev-user',
    env_id: 'flappy_bird',
    mode: 'human' as const,
    status: 'starting' as const,
    termination_reason: null,
    recording_id: 'flappy_bird-s1',
    created_at: '2026-06-11T00:00:00.000Z',
    ended_at: null,
  }
}

function endedOwnerRow() {
  return {
    ...ownerRow(),
    status: 'ended' as const,
    termination_reason: 'terminated' as const,
    ended_at: '2026-06-11T00:00:02.000Z',
  }
}

function recordingText(): string {
  const header = JSON.stringify(HEADER)
  const states = [0, 1, 2].map((tick) =>
    JSON.stringify({
      schema_version: 1,
      tick,
      agents: { player_0: { reward: 0, score: 20 + tick } },
      timing: { started_at: tick, duration_ms: 1 },
    }),
  )
  return `${header}\n${states.join('\n')}\n`
}

async function renderSession() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/sessions/:id', component: SessionPage },
      { path: '/replays/:id', component: { template: '<div>replay</div>' } },
    ],
  })
  router.push('/sessions/s1')
  await router.isReady()
  render(MeProvider, { slots: { default: () => h(RouterView) }, global: { plugins: [router] } })
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
    vi.mocked(getRecording).mockResolvedValue(recordingText())
    vi.mocked(listRecordings).mockResolvedValue([])
  })

  it('mounts the renderer for the owner of a human session and wires input + active timeout', async () => {
    vi.mocked(getMe).mockResolvedValue({ user_id: 'dev-user', allowlisted: true })
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

    // The paced per-step window shows while the owner controls a slot.
    expect(await screen.findByText(/Per-step input window: 50 ms/)).toBeInTheDocument()
  })

  it('reflects pause/resume echoes and sends the toggle command', async () => {
    vi.mocked(getMe).mockResolvedValue({ user_id: 'dev-user', allowlisted: true })
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
    vi.mocked(getMe).mockResolvedValue({ user_id: 'dev-user', allowlisted: true })
    vi.mocked(getSession).mockResolvedValue(ownerRow())
    await renderSession()
    await waitForHandlers()
    handlers.onHeader(HEADER)
    handlers.onResult?.({ ticks: 42, reason: 'terminated', scores: { player_0: 7 } })
    handlers.onSessionStatus?.('ended', 'terminated')

    expect(await screen.findByRole('heading', { name: 'Game over' })).toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open replay' })).toHaveAttribute(
      'href',
      '/replays/flappy_bird-s1',
    )
  })

  it('returns to an ended session without opening a socket and shows recording metadata', async () => {
    vi.mocked(getMe).mockResolvedValue({ user_id: 'dev-user', allowlisted: true })
    vi.mocked(getSession).mockResolvedValue(endedOwnerRow())
    vi.mocked(listRecordings).mockResolvedValue([
      {
        id: 'flappy_bird-s1',
        header: HEADER,
        user_id: 'dev-user',
        created_at: '2026-06-11T00:00:00.000Z',
        pinned: true,
      },
    ])
    await renderSession()

    expect(await screen.findByRole('heading', { name: 'Game over' })).toBeInTheDocument()
    expect(handlers).toBeUndefined()
    expect(screen.getByText('Mode')).toBeInTheDocument()
    expect(screen.getByText('Human')).toBeInTheDocument()
    expect(await screen.findByText('Final score')).toBeInTheDocument()
    expect(screen.getByText('22')).toBeInTheDocument()
    expect(screen.getByText('Pinned')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Pinned ✓' })).toBeInTheDocument()
  })

  it('gives a spectator no controls and no input', async () => {
    vi.mocked(getMe).mockResolvedValue({ user_id: 'someone-else', allowlisted: true })
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

  it('shows "No such session" when the row is missing', async () => {
    vi.mocked(getMe).mockResolvedValue({ user_id: 'dev-user', allowlisted: true })
    vi.mocked(getSession).mockResolvedValue(undefined)
    await renderSession()
    expect(await screen.findByText('No such session.')).toBeInTheDocument()
  })
})
