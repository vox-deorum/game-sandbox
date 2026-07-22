import { fireEvent, screen, waitFor } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionSocketHandlers } from '../src/api/socket.js'
import type { RendererContext } from '../src/renderers/types.js'
import { flappyHeader, flappyMeta, flappyState, heartsMeta } from './helpers/fixtures.js'

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
        render: (state: unknown) => drawn.push(state),
        destroy: () => {},
      }
    },
  }),
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
    expect(mountContext?.controlledSlots).toEqual(['player_0'])
    expect(drawn).toHaveLength(1)

    mountContext?.sendAction?.('player_0', 1)
    expect(sent).toContainEqual({ kind: 'input', slot: 'player_0', action: 1 })
  })

  it('uses the header human seat instead of every human-capable environment seat', async () => {
    vi.mocked(getEnvironments).mockResolvedValue([heartsMeta()])
    await renderLocal()

    handlers.onHeader({
      schema_version: 1,
      environment: 'hearts',
      seed: 0,
      players: {
        player_0: { kind: 'agent', label: 'Naive agent' },
        player_1: { kind: 'agent', label: 'Naive agent' },
        player_2: { kind: 'human', label: 'Local player' },
        player_3: { kind: 'agent', label: 'Naive agent' },
      },
    })

    expect(mountContext?.controlledSlots).toEqual(['player_2'])
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

  it('shows final standings when the environment completes normally', async () => {
    await renderLocal()
    startPaused()
    handlers.onState(flappyState(1))
    handlers.onResult?.({ scores: { player_0: 4 }, ticks: 1, reason: 'terminated' })
    handlers.onSessionStatus?.('ended', 'terminated')

    expect(await screen.findByRole('dialog', { name: 'Game over' })).toBeInTheDocument()
  })

  it('shows an error when the bridge metadata is absent', async () => {
    vi.mocked(getEnvironments).mockResolvedValue([])
    render(LocalPlayPage)

    expect(
      await screen.findByText('Local play could not load its environment.'),
    ).toBeInTheDocument()
  })
})
