import type { StepState } from '@game-sandbox/schema'
import { fireEvent, screen, waitFor } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RendererContext } from '../src/renderers/types.js'
import {
  flappyMeta,
  flappyState,
  recordingText,
  seatState,
  spadesMeta,
  spadesPlayers,
} from './helpers/fixtures.js'
import { signedInMe } from './helpers/me.js'
import { memoryRouter, renderWithMe } from './helpers/render.js'

const META = flappyMeta({ description: '' })

/** The four-state Flappy Bird recording the suite scrubs (score 10 + tick). `version` overrides the
 *  header schema version to exercise the needs-newer-viewer path. */
function replayRecording(version = 1): string {
  const states = [0, 1, 2, 3].map((t) => flappyState(t, 10 + t))
  return recordingText(states, { schemaVersion: version })
}

let drawn: StepState[]
let mountCtx: RendererContext | null
vi.mock('../src/renderers/registry.js', () => ({
  getRenderer: () => ({
    mount: (ctx: RendererContext) => {
      mountCtx = ctx
      return { render: (s: StepState) => drawn.push(s), destroy: () => {} }
    },
    thumbnail: '',
    internalSize: { width: 288, height: 512 },
    aspectRatio: 288 / 512,
  }),
}))

vi.mock('../src/api/client.js', () => ({
  getRecording: vi.fn(),
  getEnvironments: vi.fn(async () => [META]),
  listRecordings: vi.fn(async () => []),
  listSeasons: vi.fn(async () => []),
  watchAgentNumbers: vi.fn(async () => ({})),
  getMe: vi.fn(),
  pinRecording: vi.fn(async () => ({ ok: true })),
  unpinRecording: vi.fn(async () => ({ ok: true })),
}))

import {
  getEnvironments,
  getMe,
  getRecording,
  listRecordings,
  pinRecording,
} from '../src/api/client.js'
import ReplayPage from '../src/pages/ReplayPage.vue'

async function renderReplay(path = '/replays/rec-1'): Promise<ReturnType<typeof renderWithMe>> {
  const router = memoryRouter([
    // Stubs so the ExperimentTabs strip's links (game name, Overview, Leaderboards, My Submissions)
    // resolve; the catch-all absorbs the per-section tab targets without a route each.
    { path: '/', component: { template: '<div />' } },
    { path: '/environments/:envId', component: { template: '<div />' } },
    { path: '/replays/:id', component: ReplayPage },
    { path: '/:pathMatch(.*)*', component: { template: '<div />' } },
  ])
  router.push(path)
  await router.isReady()
  return renderWithMe(router)
}

describe('ReplayPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    drawn = []
    mountCtx = null
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user'))
  })

  it('loads, mounts a draw-only renderer, and renders transport controls', async () => {
    vi.mocked(getRecording).mockResolvedValue(replayRecording())
    const view = await renderReplay()

    expect(await screen.findByRole('button', { name: 'Play' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Step back' })).toHaveTextContent('←')
    expect(screen.getByRole('button', { name: 'Step forward' })).toHaveTextContent('→')
    // Draw-only: no controlled slots and no input.
    expect(mountCtx?.controlledSlots).toEqual([])
    expect(mountCtx?.sendAction).toBeUndefined()
    // The first frame draws on load.
    expect(drawn.at(-1)?.tick).toBe(0)
    expect(screen.getByText('Ticks')).toBeInTheDocument()
    expect(screen.getByText('4')).toBeInTheDocument()
    const controls = view.container.querySelector('.replay-controls')
    const renderer = view.container.querySelector('.renderer-host')
    expect(controls?.querySelectorAll('.ui-button.tight')).toHaveLength(3)
    expect(
      controls !== null &&
        renderer !== null &&
        Boolean(controls.compareDocumentPosition(renderer) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true)
  })

  it('scrubs with the slider keyboard to the state under the index', async () => {
    vi.mocked(getRecording).mockResolvedValue(replayRecording())
    await renderReplay()
    const slider = await screen.findByRole('slider')
    // The scrubber is the Reka UiSlider: the arrow keys move it, and each move seeks the transport.
    await fireEvent.keyDown(slider, { key: 'ArrowRight' })
    await fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(drawn.at(-1)?.tick).toBe(2)
  })

  it('operates the transport from the keyboard on the stage region', async () => {
    vi.mocked(getRecording).mockResolvedValue(replayRecording())
    const view = await renderReplay()
    await screen.findByRole('button', { name: 'Play' })
    const stage = view.container.querySelector('.stage') as HTMLElement
    // Arrows step, End jumps to the last frame, Home back to the first.
    await fireEvent.keyDown(stage, { key: 'ArrowRight' })
    expect(drawn.at(-1)?.tick).toBe(1)
    await fireEvent.keyDown(stage, { key: 'End' })
    expect(drawn.at(-1)?.tick).toBe(3)
    await fireEvent.keyDown(stage, { key: 'Home' })
    expect(drawn.at(-1)?.tick).toBe(0)
  })

  it('seeks on load from a ?t= deep link', async () => {
    vi.mocked(getRecording).mockResolvedValue(replayRecording())
    await renderReplay('/replays/rec-1?t=2')
    await waitFor(() => expect(drawn.at(-1)?.tick).toBe(2))
  })

  it('shows the game-over card at the final frame of a completed run', async () => {
    vi.mocked(getRecording).mockResolvedValue(replayRecording())
    vi.mocked(listRecordings).mockResolvedValue([
      {
        id: 'rec-1',
        header: { schema_version: 1, environment: 'flappy_bird' },
        user_id: 'dev-user',
        created_at: '2026-06-11T00:00:00.000Z',
        pinned: false,
        termination_reason: 'terminated',
        season_id: null,
      },
    ])
    const view = await renderReplay()
    await screen.findByRole('button', { name: 'Play' })
    const stage = view.container.querySelector('.stage') as HTMLElement
    // Not at the end yet, so no final standings.
    expect(screen.queryByRole('dialog', { name: 'Game over' })).toBeNull()
    await fireEvent.keyDown(stage, { key: 'End' })
    expect(await screen.findByRole('dialog', { name: 'Game over' })).toBeInTheDocument()
  })

  it('shows no game-over card at the final frame when the run did not complete', async () => {
    vi.mocked(getRecording).mockResolvedValue(replayRecording())
    vi.mocked(listRecordings).mockResolvedValue([
      {
        id: 'rec-1',
        header: { schema_version: 1, environment: 'flappy_bird' },
        user_id: 'dev-user',
        created_at: '2026-06-11T00:00:00.000Z',
        pinned: false,
        termination_reason: null,
        season_id: null,
      },
    ])
    const view = await renderReplay()
    await screen.findByRole('button', { name: 'Play' })
    const stage = view.container.querySelector('.stage') as HTMLElement
    await fireEvent.keyDown(stage, { key: 'End' })
    expect(drawn.at(-1)?.tick).toBe(3)
    expect(screen.queryByRole('dialog', { name: 'Game over' })).toBeNull()
  })

  it('shows the needs-newer-viewer message for an unknown schema version', async () => {
    vi.mocked(getRecording).mockResolvedValue(replayRecording(2))
    await renderReplay()
    expect(await screen.findByText(/needs a newer viewer/)).toBeInTheDocument()
  })

  it('offers a pin toggle to the owner and pins on click', async () => {
    vi.mocked(getRecording).mockResolvedValue(replayRecording())
    vi.mocked(listRecordings).mockResolvedValue([
      {
        id: 'rec-1',
        header: { schema_version: 1, environment: 'flappy_bird' },
        user_id: 'dev-user',
        created_at: '2026-06-11T00:00:00.000Z',
        pinned: false,
        termination_reason: 'terminated',
        season_id: null,
      },
    ])
    const view = await renderReplay()
    const pinButton = await screen.findByRole('button', { name: 'Pin recording' })
    const controls = view.container.querySelector('.replay-controls')
    expect(controls?.lastElementChild).toBe(pinButton)
    expect(controls?.querySelectorAll('.ui-button.tight')).toHaveLength(4)
    await fireEvent.click(pinButton)
    expect(vi.mocked(pinRecording)).toHaveBeenCalledWith('rec-1')
    expect(await screen.findByRole('button', { name: 'Pinned ✓' })).toBeInTheDocument()
  })

  it('labels the status badge with the producing session’s termination reason', async () => {
    vi.mocked(getRecording).mockResolvedValue(replayRecording())
    vi.mocked(listRecordings).mockResolvedValue([
      {
        id: 'rec-1',
        header: { schema_version: 1, environment: 'flappy_bird' },
        user_id: 'someone-else',
        created_at: '2026-06-11T00:00:00.000Z',
        pinned: false,
        termination_reason: 'terminated',
        season_id: null,
      },
    ])
    await renderReplay()
    // The reason resolves with the listing; until then the badge reads the neutral "Replay" fallback.
    expect(await screen.findByText('Game over')).toBeInTheDocument()
  })

  it('falls back to a plain Replay badge when no listing reason is available', async () => {
    vi.mocked(getRecording).mockResolvedValue(replayRecording())
    vi.mocked(listRecordings).mockResolvedValue([])
    await renderReplay()
    await screen.findByRole('button', { name: 'Play' })
    expect(screen.getByText('Replay')).toBeInTheDocument()
  })

  it('shows no pin toggle to a non-owner', async () => {
    vi.mocked(getRecording).mockResolvedValue(replayRecording())
    vi.mocked(listRecordings).mockResolvedValue([
      {
        id: 'rec-1',
        header: { schema_version: 1, environment: 'flappy_bird' },
        user_id: 'someone-else',
        created_at: '2026-06-11T00:00:00.000Z',
        pinned: false,
        termination_reason: null,
        season_id: null,
      },
    ])
    await renderReplay()
    await screen.findByRole('button', { name: 'Play' })
    expect(screen.queryByRole('button', { name: /Pin/ })).toBeNull()
  })

  it('shows chat messages at or before the transport position, including targeted ones', async () => {
    // mockResolvedValueOnce so the spades meta does not leak into later tests' flappy default.
    vi.mocked(getEnvironments).mockResolvedValueOnce([spadesMeta()])
    const states = [
      seatState(0),
      seatState(1, { messages: [{ from: 'player_0', to: null, text: 'good luck all' }] }),
      seatState(2),
      seatState(3, { messages: [{ from: 'player_1', to: 'player_3', text: 'cover the king' }] }),
    ]
    vi.mocked(getRecording).mockResolvedValue(
      recordingText(states, { environment: 'spades', players: spadesPlayers() }),
    )
    const view = await renderReplay()
    await screen.findByRole('button', { name: 'Play' })
    const stage = view.container.querySelector('.stage') as HTMLElement

    // At load (index 0, tick 0) no message is visible yet.
    expect(screen.queryByText('good luck all')).toBeNull()

    // Stepping to tick 1 reveals the broadcast, but not the later targeted line.
    await fireEvent.keyDown(stage, { key: 'ArrowRight' })
    expect(screen.getByText('good luck all')).toBeInTheDocument()
    expect(screen.queryByText('cover the king')).toBeNull()

    // End reveals every message, including the agent-to-agent targeted one a live spectator never saw.
    await fireEvent.keyDown(stage, { key: 'End' })
    expect(screen.getByText('good luck all')).toBeInTheDocument()
    expect(screen.getByText('cover the king')).toBeInTheDocument()
    // The targeted line names its recipient by seat, so a same-labelled roster stays unambiguous.
    expect(screen.getByText('to Player 3')).toBeInTheDocument()

    // Home empties it again, and a replay never offers a composer.
    await fireEvent.keyDown(stage, { key: 'Home' })
    expect(screen.queryByText('good luck all')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})
