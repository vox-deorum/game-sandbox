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
      return {
        aspectRatio: 288 / 512,
        render: (s: StepState) => drawn.push(s),
        destroy: () => {},
      }
    },
    thumbnail: '',
    internalSize: { width: 288, height: 512 },
    aspectRatio: 288 / 512,
  }),
}))

vi.mock('../src/api/client.js', () => ({
  getRecording: vi.fn(),
  getRecordingLlm: vi.fn(),
  getEnvironments: vi.fn(async () => [META]),
  listRecordings: vi.fn(async () => []),
  listSeasons: vi.fn(async () => []),
  watchAgentNumbers: vi.fn(async () => ({})),
  getMe: vi.fn(),
  pinRecording: vi.fn(async () => ({ ok: true })),
  unpinRecording: vi.fn(async () => ({ ok: true })),
}))

import type { PublicSeasonView } from '../src/api/client.js'
import {
  getEnvironments,
  getMe,
  getRecording,
  getRecordingLlm,
  listRecordings,
  listSeasons,
  pinRecording,
  watchAgentNumbers,
} from '../src/api/client.js'
import ReplayPage from '../src/pages/ReplayPage.vue'

/** A public season fixture: play-open by default, so a viewer other than an admin is blind while it
 *  matches a listed recording's season_id. */
function openSeason(overrides: Partial<PublicSeasonView> = {}): PublicSeasonView {
  return {
    id: 'season-1',
    env_id: 'flappy_bird',
    submission_status: 'closed',
    play_status: 'open',
    release_status: 'unreleased',
    label: 'Playground',
    created_at: '2026-06-01T00:00:00Z',
    released_at: null,
    submission_count: 1,
    game_count: 0,
    ...overrides,
  }
}

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
    vi.mocked(getRecordingLlm).mockResolvedValue({
      ok: true,
      telemetry: { calls: [], total_budget_cost_units: 0 },
    })
    vi.mocked(listRecordings).mockResolvedValue([])
    vi.mocked(listSeasons).mockResolvedValue([])
    vi.mocked(watchAgentNumbers).mockResolvedValue({})
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

  it('keeps successful empty telemetry distinct and shows None for decision costs', async () => {
    vi.mocked(getRecording).mockResolvedValue(replayRecording())
    await renderReplay()

    expect(await screen.findByRole('button', { name: 'Play' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'LLM cost' })).toBeInTheDocument()
    expect(screen.getAllByText('None')).toHaveLength(4)
    expect(
      screen.getByRole('button', { name: 'Show whole-recording LLM cost details' }),
    ).toHaveTextContent('0 units')
    expect(screen.queryByText('LLM cost data unavailable.')).toBeNull()
  })

  it('leaves the replay usable when retained telemetry is unavailable', async () => {
    vi.mocked(getRecording).mockResolvedValue(replayRecording())
    vi.mocked(getRecordingLlm).mockResolvedValue({
      ok: false,
      reason: 'telemetry_unavailable',
    })
    await renderReplay()

    expect(await screen.findByRole('button', { name: 'Play' })).toBeInTheDocument()
    expect(drawn.at(-1)?.tick).toBe(0)
    expect(screen.getByText('LLM cost data unavailable.')).toBeInTheDocument()
    expect(screen.getAllByText('Unavailable')).toHaveLength(4)
    expect(
      screen.queryByRole('button', { name: 'Show whole-recording LLM cost details' }),
    ).toBeNull()
    expect(screen.queryByText('None')).toBeNull()
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

  it('shows the owner metadata item as the display name when the listing carries user_name', async () => {
    vi.mocked(getRecording).mockResolvedValue(replayRecording())
    vi.mocked(listRecordings).mockResolvedValue([
      {
        id: 'rec-1',
        header: { schema_version: 1, environment: 'flappy_bird' },
        user_id: 'someone-else',
        user_name: 'Someone Else',
        created_at: '2026-06-11T00:00:00.000Z',
        pinned: false,
        termination_reason: 'terminated',
        season_id: null,
      },
    ])
    await renderReplay()
    const owner = await screen.findByText('Someone Else')
    expect(screen.queryByText('someone-else')).toBeNull()
    // The stable id still rides as the metadata item's tooltip even once the display name shows.
    expect(owner).toHaveAttribute('title', 'someone-else')
  })

  it('falls back to the owner id in the metadata strip when the listing carries no user_name', async () => {
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
    const owner = await screen.findByText('someone-else')
    expect(owner).toHaveAttribute('title', 'someone-else')
  })

  it('hides the Owner metadata item entirely for a blind replay carrying a submitted agent', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('viewer'))
    vi.mocked(getRecording).mockResolvedValue(
      recordingText([flappyState(0, 10)], {
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
    vi.mocked(listRecordings).mockResolvedValue([
      {
        id: 'rec-1',
        header: { schema_version: 1, environment: 'flappy_bird' },
        user_id: 'someone-else',
        user_name: 'Someone Else',
        created_at: '2026-06-11T00:00:00.000Z',
        pinned: false,
        termination_reason: 'terminated',
        season_id: 'season-1',
      },
    ])
    vi.mocked(listSeasons).mockResolvedValue([openSeason()])
    await renderReplay()
    await screen.findByRole('button', { name: 'Play' })

    // Blind masks ownership entirely: the whole metadata item vanishes, not just the name.
    expect(screen.queryByText('Owner')).toBeNull()
    expect(screen.queryByText('Someone Else')).toBeNull()
  })

  it('keeps the Owner metadata item visible for a playable season whose recording has no submitted agent', async () => {
    // Mirrors ReplaysPage's isBlindReplay gate: blind ownership masking has nothing to protect when no
    // seat is a submitted agent, so the owner still shows even while the season plays.
    vi.mocked(getMe).mockResolvedValue(signedInMe('viewer'))
    vi.mocked(getRecording).mockResolvedValue(replayRecording())
    vi.mocked(listRecordings).mockResolvedValue([
      {
        id: 'rec-1',
        header: { schema_version: 1, environment: 'flappy_bird' },
        user_id: 'someone-else',
        user_name: 'Someone Else',
        created_at: '2026-06-11T00:00:00.000Z',
        pinned: false,
        termination_reason: 'terminated',
        season_id: 'season-1',
      },
    ])
    vi.mocked(listSeasons).mockResolvedValue([openSeason()])
    await renderReplay()

    const owner = await screen.findByText('Someone Else')
    expect(owner).toHaveAttribute('title', 'someone-else')
  })

  it('shows a stable-id tooltip on a submitted-agent attribution row when not blind', async () => {
    vi.mocked(getRecording).mockResolvedValue(
      recordingText([flappyState(0, 10)], {
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
    vi.mocked(listRecordings).mockResolvedValue([
      {
        id: 'rec-1',
        header: { schema_version: 1, environment: 'flappy_bird' },
        user_id: 'maya-fledgling',
        created_at: '2026-06-11T00:00:00.000Z',
        pinned: false,
        termination_reason: 'terminated',
        season_id: null,
      },
    ])
    await renderReplay()

    const attribution = (await screen.findAllByText("maya-fledgling's agent")).find(
      (element) => element.getAttribute('title') === 'maya-fledgling',
    )
    expect(attribution).toBeDefined()
    expect(attribution).toHaveAttribute('title', 'maya-fledgling')
  })

  it("masks a submitted agent's attribution tooltip while blind, but keeps the viewer's own agent's", async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('maya-fledgling'))
    vi.mocked(getRecording).mockResolvedValue(
      recordingText([flappyState(0, 10)], {
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
    vi.mocked(listRecordings).mockResolvedValue([
      {
        id: 'rec-1',
        header: { schema_version: 1, environment: 'flappy_bird' },
        user_id: 'someone-else',
        created_at: '2026-06-11T00:00:00.000Z',
        pinned: false,
        termination_reason: null,
        season_id: 'season-1',
      },
    ])
    vi.mocked(listSeasons).mockResolvedValue([openSeason()])
    vi.mocked(watchAgentNumbers).mockResolvedValue({ 'sub-maya': 1 })
    await renderReplay()

    // "Your agent" still names the viewer's own seat; the plan requires its id stay reachable.
    const attribution = await screen.findByText('Your agent')
    expect(attribution).toHaveAttribute('title', 'maya-fledgling')
  })

  it("omits the identity tooltip on a submitted agent's row masked while blind", async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('viewer'))
    vi.mocked(getRecording).mockResolvedValue(
      recordingText([flappyState(0, 10)], {
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
    vi.mocked(listRecordings).mockResolvedValue([
      {
        id: 'rec-1',
        header: { schema_version: 1, environment: 'flappy_bird' },
        user_id: 'someone-else',
        created_at: '2026-06-11T00:00:00.000Z',
        pinned: false,
        termination_reason: null,
        season_id: 'season-1',
      },
    ])
    vi.mocked(listSeasons).mockResolvedValue([openSeason()])
    vi.mocked(watchAgentNumbers).mockResolvedValue({ 'sub-maya': 1 })
    await renderReplay()

    const attribution = await screen.findByText('Agent 1')
    expect(attribution).not.toHaveAttribute('title')
    expect(screen.queryByText("maya-fledgling's agent")).toBeNull()
  })

  it('keeps pin ownership keyed on user_id even when user_name reads like the viewer', async () => {
    // A display name that happens to match the viewer's own name must not fool the ownership check,
    // which the plan requires stay on the stable id.
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user'))
    vi.mocked(getRecording).mockResolvedValue(replayRecording())
    vi.mocked(listRecordings).mockResolvedValue([
      {
        id: 'rec-1',
        header: { schema_version: 1, environment: 'flappy_bird' },
        user_id: 'someone-else',
        user_name: 'dev-user',
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
    expect(screen.getByText('to P3')).toBeInTheDocument()

    // Home empties it again, and a replay never offers a composer.
    await fireEvent.keyDown(stage, { key: 'Home' })
    expect(screen.queryByText('good luck all')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})
