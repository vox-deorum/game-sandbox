import type { StepState } from '@game-sandbox/schema'
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { fireEvent, render, screen, waitFor } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'

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

function state(tick: number): StepState {
  return { schema_version: 1, tick, agents: {}, timing: { started_at: tick, duration_ms: 1 } }
}

function recordingText(version = 1): string {
  const header = JSON.stringify({ schema_version: version, environment: 'flappy_bird', seed: 0 })
  const lines = [0, 1, 2, 3].map((t) => JSON.stringify(state(t)))
  return `${header}\n${lines.join('\n')}\n`
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
import { MeProvider } from '../src/me.js'
import ReplayPage from '../src/pages/replay.vue'

async function renderReplay(path = '/replays/rec-1'): Promise<void> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/replays/:id', component: ReplayPage }],
  })
  router.push(path)
  await router.isReady()
  render(MeProvider, { slots: { default: () => h(RouterView) }, global: { plugins: [router] } })
}

describe('ReplayPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    drawn = []
    mountCtx = null
    vi.mocked(getMe).mockResolvedValue({ user_id: 'dev-user', allowlisted: true })
  })

  it('loads, mounts a draw-only renderer, and renders transport controls', async () => {
    vi.mocked(getRecording).mockResolvedValue(recordingText())
    await renderReplay()

    expect(await screen.findByRole('button', { name: 'Play' })).toBeInTheDocument()
    // Draw-only: no controlled slots and no input.
    expect(mountCtx?.controlledSlots).toEqual([])
    expect(mountCtx?.sendAction).toBeUndefined()
    // The first frame draws on load.
    expect(drawn.at(-1)?.tick).toBe(0)
  })

  it('scrubs to the state under the slider index', async () => {
    vi.mocked(getRecording).mockResolvedValue(recordingText())
    await renderReplay()
    const slider = (await screen.findByRole('slider')) as HTMLInputElement
    await fireEvent.update(slider, '2')
    expect(drawn.at(-1)?.tick).toBe(2)
  })

  it('seeks on load from a ?t= deep link', async () => {
    vi.mocked(getRecording).mockResolvedValue(recordingText())
    await renderReplay('/replays/rec-1?t=2')
    await waitFor(() => expect(drawn.at(-1)?.tick).toBe(2))
  })

  it('shows the needs-newer-viewer message for an unknown schema version', async () => {
    vi.mocked(getRecording).mockResolvedValue(recordingText(2))
    await renderReplay()
    expect(await screen.findByText(/needs a newer viewer/)).toBeInTheDocument()
  })

  it('offers a pin toggle to the owner and pins on click', async () => {
    vi.mocked(getRecording).mockResolvedValue(recordingText())
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
    vi.mocked(getRecording).mockResolvedValue(recordingText())
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
