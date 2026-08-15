import { fireEvent, screen, waitFor } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionSocketHandlers } from '../src/api/socket.js'
import type { RendererContext } from '../src/renderers/types.js'
import {
  flappyHeader,
  flappyMeta,
  flappyState,
  heartsMeta,
  playerState,
  spadesHeader,
  spadesMeta,
  spadesPlayers,
} from './helpers/fixtures.js'

let handlers: SessionSocketHandlers
let sent: unknown[]
let socketPath: string | null

vi.mock('../src/api/socket.js', () => ({
  SessionSocket: class {
    constructor(path: string, incoming: SessionSocketHandlers) {
      socketPath = path
      handlers = incoming
    }
    connect(): void {}
    send(command: unknown): void {
      sent.push(command)
    }
    close(): void {}
  },
}))

let mountContext: RendererContext | null
let drawn: unknown[]
vi.mock('../src/renderers/registry.js', () => ({
  getRenderer: () => ({
    mount: (context: RendererContext) => {
      mountContext = context
      return {
        aspectRatio: 288 / 512,
        render: (state: unknown) => {
          drawn.push(state)
          return Promise.resolve()
        },
        destroy: () => {},
      }
    },
  }),
  playerNamesFor: () => undefined,
}))

vi.mock('../src/api/client.js', () => ({
  getEnvironments: vi.fn(),
}))

import { render } from '@testing-library/vue'

import { getEnvironments } from '../src/api/client.js'
import LocalPlayPage from '../src/local/LocalPlayPage.vue'

async function renderLocal() {
  render(LocalPlayPage)
  await waitFor(() => expect(handlers).toBeDefined())
}

function startPaused(): void {
  handlers.onHeader(
    flappyHeader({ players: { player_0: { kind: 'human', label: 'Local player' } } }),
  )
  handlers.onState({
    schema_version: 1,
    tick: 0,
    agents: {},
    timing: { started_at: 0, duration_ms: 0 },
  })
  handlers.onSessionStatus?.('running')
  handlers.onPause?.()
}

describe('LocalPlayPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    handlers = undefined as unknown as SessionSocketHandlers
    sent = []
    socketPath = null
    mountContext = null
    drawn = []
    vi.mocked(getEnvironments).mockResolvedValue([flappyMeta()])
  })

  it('loads the one bridge metadata entry, mounts its renderer, and controls the attributed human seat', async () => {
    await renderLocal()
    expect(socketPath).toBe('/api/sessions/local/ws')

    startPaused()
    await waitFor(() => expect(mountContext).not.toBeNull())
    expect(mountContext?.controlledPlayers).toEqual(['player_0'])
    expect(drawn).toHaveLength(1)

    handlers.onConnectionChange?.('open')
    mountContext?.sendAction?.('player_0', 1)
    expect(sent).toContainEqual({ kind: 'input', player: 'player_0', action: 1 })
  })

  it('uses the header human seat instead of every human-capable environment seat', async () => {
    vi.mocked(getEnvironments).mockResolvedValue([heartsMeta()])
    await renderLocal()

    handlers.onHeader({
      schema_version: 1,
      environment: 'hearts',
      parameters: { players: 4 },
      seed: 0,
      players: {
        player_0: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
        player_1: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
        player_2: { kind: 'human', label: 'Local player' },
        player_3: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
      },
      seats: {
        seat_0: ['player_0'],
        seat_1: ['player_1'],
        seat_2: ['player_2'],
        seat_3: ['player_3'],
      },
      seat_plan: 'solo',
    })

    expect(mountContext?.controlledPlayers).toEqual(['player_2'])
  })

  it('starts only by sending resume, then follows pause and resume echoes', async () => {
    await renderLocal()
    startPaused()

    const start = await screen.findByRole('button', { name: 'Start' })
    await fireEvent.click(start)
    expect(sent).toContainEqual({ kind: 'resume' })
    expect(screen.getByText('Paused')).toBeInTheDocument()

    handlers.onResume?.()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument())
    await fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(sent).toContainEqual({ kind: 'pause' })

    handlers.onPause?.()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument())
  })

  it('pauses local playback with no wire command once started, for a human_pause: playback environment', async () => {
    // Flappy Bird normally session-pauses; override it to playback so the ordinary Pause/Resume button
    // (distinct from the Start gate below, which always sends a real resume) never reaches the wire.
    vi.mocked(getEnvironments).mockResolvedValue([flappyMeta({ human_pause: 'playback' })])
    await renderLocal()
    startPaused()

    const start = await screen.findByRole('button', { name: 'Start' })
    await fireEvent.click(start)
    expect(sent).toContainEqual({ kind: 'resume' })

    handlers.onResume?.()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument())
    sent.length = 0 // clear the Start gate's resume; the assertions below cover the ordinary toggle only

    await fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(sent).toEqual([])
    expect(screen.getAllByText('Paused').length).toBeGreaterThan(0)

    // Two frames arrive while paused; unbuffered playout queues each one rather than drawing it (or
    // dropping it in favor of only the newest), so nothing new draws yet.
    handlers.onState(flappyState(1, 2))
    handlers.onState(flappyState(2, 3))
    expect(drawn).toHaveLength(1) // only the opening frame startPaused() sent before Start

    await fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(sent).toEqual([])
    await waitFor(() => expect(screen.queryByText('Paused')).toBeNull())
    // Every paused-through frame is delivered in order, not just the newest.
    expect(drawn).toHaveLength(3)
    expect(drawn.slice(-2)).toEqual([flappyState(1, 2), flappyState(2, 3)])
  })

  it('paces an all-agent local Flappy Bird watch at its own pace interval, not the 1 s default', async () => {
    // flappyMeta() declares pace_interval_ms: 50 (view_interval_ms is null), and LocalPlayPage now
    // passes playbackIntervalMs(environment) to connect() instead of the raw view interval, so a local
    // watch of an all-agent Flappy session should pace at 50 ms rather than the buffer's 1000 ms default.
    await renderLocal()
    vi.useFakeTimers()
    try {
      handlers.onHeader(flappyHeader()) // default players: player_0 is an agent, so this is a watch
      const watched = flappyState(0, 1)
      handlers.onState(watched)
      handlers.onState(flappyState(1, 2))
      handlers.onState(flappyState(2, 3)) // fills the lead (150 ms / 50 ms cadence = 3 frames)

      expect(drawn).toEqual([])
      vi.advanceTimersByTime(50)
      await Promise.resolve()
      expect(drawn).toEqual([watched])
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows Resume, not the start gate, after a paused mid-game reconnect replay', async () => {
    await renderLocal()
    handlers.onHeader(
      flappyHeader({ players: { player_0: { kind: 'human', label: 'Local player' } } }),
    )
    handlers.onState(flappyState(3))
    handlers.onSessionStatus?.('running')
    handlers.onPause?.()
    handlers.onConnectionChange?.('reconnecting')

    expect(await screen.findByText('Reconnecting…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()
  })

  it('logs every simultaneous action and omits reward-only entries', async () => {
    await renderLocal()
    handlers.onHeader(
      flappyHeader({ players: { player_0: { kind: 'human', label: 'Local player' } } }),
    )
    const state = {
      schema_version: 1,
      tick: 3,
      agents: {
        player_0: { reward: 1, score: 1, action: 'left' },
        player_1: { reward: 0, score: 0, action: 'right' },
        player_2: { reward: 2, score: 2 },
      },
      timing: { started_at: 0, duration_ms: 1 },
    } as const
    handlers.onState(state)
    handlers.onState(state)

    await waitFor(() =>
      expect(document.querySelectorAll('.decision-log tbody:last-of-type tr')).toHaveLength(2),
    )
    const rows = document.querySelectorAll('.decision-log tbody:last-of-type tr')
    expect(rows[0]).toHaveTextContent('P0')
    expect(rows[1]).toHaveTextContent('P1')
    expect(document.querySelector('.decision-log')).not.toHaveTextContent('P2')
  })

  it('waits for terminal status and labels a stopped session without final standings', async () => {
    await renderLocal()
    startPaused()
    handlers.onResume?.()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument())

    await fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(sent).toContainEqual({ kind: 'stop' })
    expect(screen.queryByRole('dialog', { name: 'Game over' })).toBeNull()

    handlers.onResult?.({ scores: { player_0: 4 }, ticks: 1, reason: 'stopped' })
    handlers.onSessionStatus?.('ended', 'stopped')
    expect(await screen.findByText('Stopped')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Game over' })).toBeNull()
  })

  it('shows complete result standings when the terminal state omits a player', async () => {
    await renderLocal()
    handlers.onHeader(
      flappyHeader({
        players: {
          player_0: { kind: 'human', label: 'North', user: 'north' },
          player_1: { kind: 'agent', builtin_name: 'naive', label: 'South' },
        },
        seats: { seat_0: ['player_0'], seat_1: ['player_1'] },
      }),
    )
    handlers.onState({
      schema_version: 1,
      tick: 1,
      agents: { player_1: { reward: 2, score: 2, action: 1 } },
      timing: { started_at: 0, duration_ms: 1 },
    })
    handlers.onResult?.({
      scores: { player_0: 4, player_1: 2 },
      ticks: 2,
      reason: 'terminated',
    })
    handlers.onSessionStatus?.('ended', 'terminated')

    const gameOver = await screen.findByRole('dialog', { name: 'Game over' })
    expect(gameOver.querySelectorAll('.row')).toHaveLength(2)
    expect(gameOver).toHaveTextContent('4')
    expect(gameOver).toHaveTextContent('2')
  })

  it('falls back to accumulated state scores until a result envelope arrives', async () => {
    await renderLocal()
    handlers.onHeader(
      flappyHeader({
        players: {
          player_0: { kind: 'human', label: 'North', user: 'north' },
          player_1: { kind: 'agent', builtin_name: 'naive', label: 'South' },
        },
        seats: { seat_0: ['player_0'], seat_1: ['player_1'] },
      }),
    )
    handlers.onState({
      schema_version: 1,
      tick: 0,
      agents: {
        player_0: { reward: 4, score: 4, action: 0 },
        player_1: { reward: 0, score: 0, action: 1 },
      },
      timing: { started_at: 0, duration_ms: 1 },
    })
    handlers.onState({
      schema_version: 1,
      tick: 1,
      agents: { player_1: { reward: 2, score: 2, action: 1 } },
      timing: { started_at: 1, duration_ms: 1 },
    })
    handlers.onSessionStatus?.('ended', 'terminated')

    const gameOver = await screen.findByRole('dialog', { name: 'Game over' })
    expect(gameOver.querySelectorAll('.row')).toHaveLength(2)
    expect(gameOver).toHaveTextContent('4')
    expect(gameOver).toHaveTextContent('2')
  })

  it('buffers an all-agent local session at its viewing cadence', async () => {
    vi.mocked(getEnvironments).mockResolvedValue([spadesMeta()])
    await renderLocal()
    vi.useFakeTimers()
    handlers.onHeader(spadesHeader({ players: spadesPlayers(null) }))
    const watched = playerState(9)
    handlers.onState(watched)
    handlers.onState(playerState(10))

    expect(drawn).toEqual([])
    vi.advanceTimersByTime(3_000)
    await Promise.resolve()
    expect(drawn).toEqual([watched])
  })

  it('sends tick-free local chat and keeps the composer available across actions', async () => {
    vi.mocked(getEnvironments).mockResolvedValue([spadesMeta()])
    await renderLocal()
    handlers.onHeader(spadesHeader())
    handlers.onSessionStatus?.('running')
    handlers.onConnectionChange?.('open')
    handlers.onState(
      playerState(9, {
        chatOptions: {
          sender: 'player_0',
          target_recipients: ['player_2'],
          default_recipient: 'player_2',
        },
      }),
    )

    const input = await screen.findByRole('textbox')
    await fireEvent.update(input, 'cover the ace')
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(sent).toContainEqual({
      kind: 'chat',
      player: 'player_0',
      to: 'player_2',
      text: 'cover the ace',
    })

    await fireEvent.update(input, 'draft across opponent turns')
    mountContext?.sendAction?.('player_0', 12)
    expect(sent).toContainEqual({ kind: 'input', player: 'player_0', action: 12 })
    expect(screen.getByRole('textbox')).toBeInTheDocument()

    handlers.onState(
      playerState(13, {
        chatOptions: {
          sender: 'player_0',
          target_recipients: ['player_1'],
          default_recipient: 'player_1',
        },
      }),
    )
    const nextInput = (await screen.findByRole('textbox')) as HTMLInputElement
    expect(screen.getByRole('combobox')).toHaveValue('player_1')
    expect(nextInput.value).toBe('draft across opponent turns')
  })

  it('restores the local chat draft after reconnect and never consumes it on an action', async () => {
    vi.mocked(getEnvironments).mockResolvedValue([spadesMeta()])
    await renderLocal()
    handlers.onHeader(spadesHeader())
    handlers.onSessionStatus?.('running')
    handlers.onState(
      playerState(9, {
        chatOptions: {
          sender: 'player_0',
          target_recipients: ['player_2'],
          default_recipient: 'player_2',
        },
      }),
    )
    handlers.onConnectionChange?.('open')

    const input = (await screen.findByRole('textbox')) as HTMLInputElement
    await fireEvent.update(input, 'cover the ace')
    handlers.onConnectionChange?.('reconnecting')

    mountContext?.sendAction?.('player_0', 12)
    await waitFor(() => expect(sent).toHaveLength(0))
    expect(screen.queryByRole('textbox')).toBeNull()

    handlers.onConnectionChange?.('open')
    const restored = (await screen.findByRole('textbox')) as HTMLInputElement
    expect(restored.value).toBe('cover the ace')
    mountContext?.sendAction?.('player_0', 12)
    expect(sent).toContainEqual({ kind: 'input', player: 'player_0', action: 12 })
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('shows an error when the bridge metadata is absent', async () => {
    vi.mocked(getEnvironments).mockResolvedValue([])
    render(LocalPlayPage)

    expect(
      await screen.findByText('Local play could not load its environment.'),
    ).toBeInTheDocument()
  })
})
