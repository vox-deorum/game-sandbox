import type { StepState } from '@game-sandbox/schema'
import { fireEvent, screen, waitFor } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RendererContext } from '../src/renderers/types.js'
import { flappyMeta, flappyState, recordingText } from './helpers/fixtures.js'
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
  getMe: vi.fn(),
  pinRecording: vi.fn(async () => ({ ok: true })),
  unpinRecording: vi.fn(async () => ({ ok: true })),
}))

import { getMe, getRecording, listRecordings, pinRecording } from '../src/api/client.js'
import ReplayPage from '../src/pages/ReplayPage.vue'

async function renderReplay(path = '/replays/rec-1'): Promise<ReturnType<typeof renderWithMe>> {
  const router = memoryRouter([
    // Stubs so the replay stage's "Environments / … / Replay" context-line links resolve.
    { path: '/', component: { template: '<div />' } },
    { path: '/environments/:envId', component: { template: '<div />' } },
    { path: '/replays/:id', component: ReplayPage },
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
    vi.mocked(getMe).mockResolvedValue({ user_id: 'dev-user', allowlisted: true })
  })

  it('loads, mounts a draw-only renderer, and renders transport controls', async () => {
    vi.mocked(getRecording).mockResolvedValue(replayRecording())
    const view = await renderReplay()

    expect(await screen.findByRole('button', { name: 'Play' })).toBeInTheDocument()
    // Draw-only: no controlled slots and no input.
    expect(mountCtx?.controlledSlots).toEqual([])
    expect(mountCtx?.sendAction).toBeUndefined()
    // The first frame draws on load.
    expect(drawn.at(-1)?.tick).toBe(0)
    expect(screen.getByText('Final score')).toBeInTheDocument()
    expect(screen.getByText('13')).toBeInTheDocument()
    expect(screen.getByText('Ticks')).toBeInTheDocument()
    expect(screen.getByText('4')).toBeInTheDocument()
    const controls = view.container.querySelector('.replay-controls')
    const renderer = view.container.querySelector('.renderer-host')
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
      },
    ])
    await renderReplay()
    const pinButton = await screen.findByRole('button', { name: 'Pin this recording' })
    await fireEvent.click(pinButton)
    expect(vi.mocked(pinRecording)).toHaveBeenCalledWith('rec-1')
    expect(await screen.findByRole('button', { name: 'Pinned ✓' })).toBeInTheDocument()
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
      },
    ])
    await renderReplay()
    await screen.findByRole('button', { name: 'Play' })
    expect(screen.queryByRole('button', { name: /Pin/ })).toBeNull()
  })
})
