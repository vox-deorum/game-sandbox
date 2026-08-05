import { fireEvent, screen, waitFor, within } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import type { SessionSocketHandlers } from '../src/api/socket.js'
import type { RendererContext } from '../src/renderers/types.js'
import {
  flappyHeader,
  flappyMeta,
  flappyState,
  heartsMeta,
  playerState,
  recordingText,
  spadesHeader,
  spadesMeta,
  spadesPlayers,
} from './helpers/fixtures.js'
import { anonymousMe, signedInMe } from './helpers/me.js'
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

// A fake renderer that records what it was mounted with, the states it drew, and the per-state render
// options (so a test can assert the paced transition budget the live throttle passes).
let mountCtx: RendererContext | null
let drawn: unknown[]
let drawnOptions: unknown[]
vi.mock('../src/renderers/registry.js', () => ({
  getRenderer: () => ({
    mount: (ctx: RendererContext) => {
      mountCtx = ctx
      return {
        aspectRatio: 288 / 512,
        render: (s: unknown, o?: unknown) => {
          drawn.push(s)
          drawnOptions.push(o)
        },
        destroy: () => {},
      }
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
  watchAgentNumbers: vi.fn(async () => ({})),
  getMe: vi.fn(),
  pinRecording: vi.fn(async () => ({ ok: true })),
  unpinRecording: vi.fn(async () => ({ ok: true })),
  // The end-of-session rating panel self-fetches on mount; default it to not-rateable so these
  // session-chrome tests render no panel. The rating UI has its own suite.
  getSessionRatings: vi.fn(async () => ({ ok: false, reason: 'not_rateable' })),
  submitRatings: vi.fn(),
}))

import {
  getEnvironments,
  getMe,
  getRecording,
  getSession,
  getSessionRatings,
  listRecordings,
  listSeasons,
  watchAgentNumbers,
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
    parameters: { players: 1, pipe_gap: 100 },
    human_timeout_ms: null,
    messaging_enabled: 0,
    message_cap: null,
    created_at: '2026-06-11T00:00:00.000Z',
    ended_at: null,
  }
}

/** A watch run: a scripted (non-human) session a viewer streams with no controls. */
function scriptedRow() {
  return { ...ownerRow(), user_id: 'someone-else', mode: 'scripted' as const }
}

/** A live human Spades session owned by dev-user, with messaging enabled and the stage's 120 cap. */
function spadesOwnerRow() {
  return {
    ...ownerRow(),
    env_id: 'spades',
    recording_id: 'spades-s1',
    messaging_enabled: 1,
    message_cap: 120,
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
    // The anonymous ended-session ratings prompt links here.
    { path: '/login', component: { template: '<div>login</div>' } },
  ])
  router.push('/sessions/s1')
  await router.isReady()
  return renderWithMe(router)
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
    drawnOptions = []
    // Reset to the Flappy default each test; the live-throttle test overrides it to a turn-based env
    // (mockResolvedValue persists across tests without a global mock reset, so re-assert the default).
    vi.mocked(getEnvironments).mockResolvedValue([META])
    vi.mocked(getRecording).mockResolvedValue(sessionRecording())
    vi.mocked(listRecordings).mockResolvedValue([])
    vi.mocked(listSeasons).mockResolvedValue([])
    vi.mocked(getSessionRatings).mockResolvedValue({ ok: false, reason: 'not_rateable' })
  })

  it('mounts the renderer for the owner of a human session and wires input', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user'))
    vi.mocked(getSession).mockResolvedValue(ownerRow())
    await renderSession()
    await waitForHandlers()

    // The header attributes player_0 to the connected human, so controlledPlayers narrows to that player.
    handlers.onHeader(
      flappyHeader({ players: { player_0: { kind: 'human', label: 'dev', user: 'dev' } } }),
    )
    handlers.onState({
      schema_version: 1,
      tick: 0,
      agents: {},
      timing: { started_at: 0, duration_ms: 0 },
    })

    expect(mountCtx?.controlledPlayers).toEqual(['player_0'])
    expect(drawn).toHaveLength(1)

    // The owner gets a live sendAction that the page forwards as an input command.
    handlers.onConnectionChange?.('open')
    mountCtx?.sendAction?.('player_0', 1)
    expect(sent).toContainEqual({ kind: 'input', player: 'player_0', action: 1 })
  })

  it("shows the human seat's display-name label in attribution, with the stable id as a tooltip", async () => {
    // A header whose human label differs from the stable id it also carries, proving the attribution
    // line prefers the display name (label) while keeping the id reachable as a tooltip — and that
    // ownership (which stays keyed on the session row's user_id, asserted elsewhere) is unaffected.
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user'))
    vi.mocked(getSession).mockResolvedValue(ownerRow())
    await renderSession()
    await waitForHandlers()

    handlers.onHeader(
      flappyHeader({
        players: { player_0: { kind: 'human', label: 'Dev User', user: 'dev-user' } },
      }),
    )
    handlers.onState({
      schema_version: 1,
      tick: 0,
      agents: {},
      timing: { started_at: 0, duration_ms: 0 },
    })

    const attribution = await screen.findByText('Human: Dev User')
    expect(attribution).toHaveAttribute('title', 'dev-user')
    expect(screen.queryByText('Human: dev-user')).toBeNull()
  })

  it("keeps a blind viewer's own human seat identified, not neutralized", async () => {
    // The blind mask exists to protect *other* players' identity; the viewer's own seat must still
    // read by its display name (and keep the id tooltip) even while the season is playable.
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user'))
    vi.mocked(getSession).mockResolvedValue(ownerRow())
    vi.mocked(listSeasons).mockResolvedValue([
      {
        id: 'flappy_bird-iter-1',
        env_id: 'flappy_bird',
        submission_status: 'closed',
        play_status: 'open',
        release_status: 'unreleased',
        label: 'Playground',
        description_markdown: null,
        created_at: '2026-06-11T00:00:00.000Z',
        released_at: null,
        submission_count: 1,
        game_count: 0,
      },
    ])
    await renderSession()
    await waitForHandlers()

    handlers.onHeader(
      flappyHeader({
        players: { player_0: { kind: 'human', label: 'Dev User', user: 'dev-user' } },
      }),
    )
    handlers.onState({
      schema_version: 1,
      tick: 0,
      agents: {},
      timing: { started_at: 0, duration_ms: 0 },
    })

    const attribution = await screen.findByText('Human: Dev User')
    expect(attribution).toHaveAttribute('title', 'dev-user')
  })

  it("masks a blind viewer's human seat that is not their own to the neutral label, with no tooltip", async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('viewer'))
    vi.mocked(getSession).mockResolvedValue(scriptedRow())
    vi.mocked(listSeasons).mockResolvedValue([
      {
        id: 'flappy_bird-iter-1',
        env_id: 'flappy_bird',
        submission_status: 'closed',
        play_status: 'open',
        release_status: 'unreleased',
        label: 'Playground',
        description_markdown: null,
        created_at: '2026-06-11T00:00:00.000Z',
        released_at: null,
        submission_count: 1,
        game_count: 0,
      },
    ])
    await renderSession()
    await waitForHandlers()

    // The header must carry a submitted agent (not just another human) for blind masking to have
    // anything to protect — an all-human game is asserted unmasked in the test right below.
    handlers.onHeader(
      flappyHeader({
        players: {
          player_0: { kind: 'human', label: 'Alice Chen', user: 'alice-chen' },
          player_1: {
            kind: 'agent',
            label: "bob's agent",
            user: 'bob',
            submission_id: 'sub-bob',
          },
        },
      }),
    )
    handlers.onState({
      schema_version: 1,
      tick: 0,
      agents: {},
      timing: { started_at: 0, duration_ms: 0 },
    })

    const attribution = await screen.findByText('Human', { exact: true })
    expect(attribution).not.toHaveAttribute('title')
    expect(screen.queryByText(/Alice Chen/)).toBeNull()
    expect(screen.queryByText(/Human: Human/)).toBeNull()
  })

  it('does not mask an all-human game in a play-open season (nothing for blind to protect)', async () => {
    // Mirrors ReplayPage's isBlindReplay gate: blind ownership masking exists to protect a submitted
    // agent's identity, so an all-human recording (no submission to protect) must show real names even
    // to a non-operator viewing a playable season.
    vi.mocked(getMe).mockResolvedValue(signedInMe('viewer'))
    vi.mocked(getSession).mockResolvedValue(scriptedRow())
    vi.mocked(listSeasons).mockResolvedValue([
      {
        id: 'flappy_bird-iter-1',
        env_id: 'flappy_bird',
        submission_status: 'closed',
        play_status: 'open',
        release_status: 'unreleased',
        label: 'Playground',
        description_markdown: null,
        created_at: '2026-06-11T00:00:00.000Z',
        released_at: null,
        submission_count: 1,
        game_count: 0,
      },
    ])
    await renderSession()
    await waitForHandlers()

    handlers.onHeader(
      flappyHeader({
        players: { player_0: { kind: 'human', label: 'Alice Chen', user: 'alice-chen' } },
      }),
    )
    handlers.onState({
      schema_version: 1,
      tick: 0,
      agents: {},
      timing: { started_at: 0, duration_ms: 0 },
    })

    const attribution = await screen.findByText('Human: Alice Chen')
    expect(attribution).toHaveAttribute('title', 'alice-chen')
  })

  it('controls the player the human actually plays, not always player 0', async () => {
    // A four-player Hearts session where the human plays player_2. The renderer keys first-person
    // control off the single controlled player, so the page must narrow to the player the header
    // attributes to the human rather than handing it every human-capable player (which would pin
    // control to player_0).
    vi.mocked(getEnvironments).mockResolvedValue([heartsMeta()])
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user'))
    vi.mocked(getSession).mockResolvedValue({
      ...ownerRow(),
      env_id: 'hearts',
      recording_id: 'hearts-s1',
    })
    await renderSession()
    await waitForHandlers()

    handlers.onHeader({
      schema_version: 1,
      environment: 'hearts',
      parameters: { players: 4 },
      seed: 0,
      players: {
        player_0: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
        player_1: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
        player_2: { kind: 'human', label: 'dev', user: 'dev' },
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

    expect(mountCtx?.controlledPlayers).toEqual(['player_2'])
    // The forwarded input carries the human's real player ID, so a click plays for player_2, not player_0.
    handlers.onConnectionChange?.('open')
    mountCtx?.sendAction?.('player_2', 5)
    expect(sent).toContainEqual({ kind: 'input', player: 'player_2', action: 5 })
  })

  it('controls every human-attributed player in a self-played wide seat', async () => {
    vi.mocked(getEnvironments).mockResolvedValue([spadesMeta()])
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user'))
    vi.mocked(getSession).mockResolvedValue(spadesOwnerRow())
    await renderSession()
    await waitForHandlers()

    handlers.onHeader(
      spadesHeader({
        players: {
          player_0: { kind: 'human', label: 'dev', user: 'dev-user' },
          player_1: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
          player_2: { kind: 'human', label: 'dev', user: 'dev-user' },
          player_3: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
        },
      }),
    )

    expect(mountCtx?.controlledPlayers).toEqual(['player_0', 'player_2'])
    handlers.onConnectionChange?.('open')
    mountCtx?.sendAction?.('player_0', 3)
    mountCtx?.sendAction?.('player_2', 7)
    expect(sent).toContainEqual({ kind: 'input', player: 'player_0', action: 3 })
    expect(sent).toContainEqual({ kind: 'input', player: 'player_2', action: 7 })
  })

  it('shows the move clock using the session timeout override, not the env default', async () => {
    // The session was started with a 5s human budget, overriding Hearts' 60s default. The renderer reads
    // the budget from meta.human_timeout_ms, so the page must overlay the session's value onto the meta
    // it mounts the renderer with.
    vi.mocked(getEnvironments).mockResolvedValue([heartsMeta()])
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user'))
    vi.mocked(getSession).mockResolvedValue({
      ...ownerRow(),
      env_id: 'hearts',
      recording_id: 'hearts-s1',
      human_timeout_ms: 5000,
    })
    await renderSession()
    await waitForHandlers()
    handlers.onHeader({
      schema_version: 1,
      environment: 'hearts',
      parameters: { players: 4 },
      players: {
        player_0: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
        player_1: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
        player_2: { kind: 'human', label: 'dev', user: 'dev' },
        player_3: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
      },
      seats: {
        seat_0: ['player_0'],
        seat_1: ['player_1'],
        seat_2: ['player_2'],
        seat_3: ['player_3'],
      },
      seat_plan: 'solo',
      seed: 0,
    })

    expect(mountCtx?.meta.human_timeout_ms).toBe(5000)
  })

  it('renders the actionless opening frame but keeps it out of the decision log', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user'))
    vi.mocked(getSession).mockResolvedValue(ownerRow())
    await renderSession()
    await waitForHandlers()

    handlers.onHeader(HEADER)
    // The live-only opening frame: a turn-based deal with no acting agent. It draws (so the table is
    // visible before the first move) but adds no decision-log row, which logs actions.
    handlers.onState({
      schema_version: 1,
      tick: 0,
      agents: {},
      timing: { started_at: 0, duration_ms: 0 },
    })
    expect(drawn).toHaveLength(1)
    expect(await screen.findByText('No decisions yet.')).toBeInTheDocument()

    // The first real action frame draws and adds exactly one decision row.
    handlers.onState({
      schema_version: 1,
      tick: 0,
      agents: { player_0: { reward: 0, score: 0, action: 1 } },
      timing: { started_at: 0, duration_ms: 0 },
    })
    expect(drawn).toHaveLength(2)
    await waitFor(() => expect(screen.queryByText('No decisions yet.')).toBeNull())
  })

  it('logs every action-bearing player in a state and omits reward-only deltas', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user'))
    vi.mocked(getSession).mockResolvedValue(ownerRow())
    const view = await renderSession()
    await waitForHandlers()

    handlers.onHeader(HEADER)
    const state = {
      schema_version: 1,
      tick: 4,
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
      expect(view.container.querySelectorAll('.decision-log tbody:last-of-type tr')).toHaveLength(
        2,
      ),
    )
    const log = view.container.querySelector('.decision-log') as HTMLElement
    const rows = log.querySelectorAll('tbody:last-of-type tr')
    expect(rows[0]).toHaveTextContent('P0')
    expect(rows[0]).toHaveTextContent('left')
    expect(rows[1]).toHaveTextContent('P1')
    expect(rows[1]).toHaveTextContent('right')
    expect(log).not.toHaveTextContent('P2')
  })

  it('reflects pause/resume echoes and sends the toggle command', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user'))
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
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user'))
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

  it('keeps the first result when an immediate stream sends a duplicate', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user'))
    vi.mocked(getSession).mockResolvedValue(ownerRow())
    const view = await renderSession()
    await waitForHandlers()
    handlers.onHeader(HEADER)
    handlers.onResult?.({ ticks: 42, reason: 'terminated', scores: { player_0: 7 } })
    handlers.onResult?.({ ticks: 99, reason: 'stopped', scores: { player_0: 99 } })
    handlers.onSessionStatus?.('ended')

    const statusBar = view.container.querySelector('.session-status') as HTMLElement
    expect(await within(statusBar).findByText('Game over')).toBeInTheDocument()
    expect(within(statusBar).getByText('7')).toBeInTheDocument()
    expect(within(statusBar).getByText('42')).toBeInTheDocument()
    expect(within(statusBar).queryByText('Stopped')).toBeNull()
    expect(within(statusBar).queryByText('99')).toBeNull()
  })

  it('uses complete result scores when the terminal state omits an inactive player', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user'))
    vi.mocked(getSession).mockResolvedValue(ownerRow())
    await renderSession()
    await waitForHandlers()
    handlers.onHeader(
      flappyHeader({
        players: {
          player_0: { kind: 'agent', builtin_name: 'naive', label: 'North' },
          player_1: { kind: 'agent', builtin_name: 'naive', label: 'South' },
        },
        seats: { seat_0: ['player_0'], seat_1: ['player_1'] },
      }),
    )
    handlers.onState({
      schema_version: 1,
      tick: 2,
      agents: { player_1: { reward: 3, score: 3, action: 1 } },
      timing: { started_at: 0, duration_ms: 1 },
    })
    handlers.onResult?.({
      ticks: 3,
      reason: 'terminated',
      scores: { player_0: 7, player_1: 3 },
    })
    handlers.onSessionStatus?.('ended', 'terminated')

    const gameOver = await screen.findByRole('dialog', { name: 'Game over' })
    expect(gameOver.querySelectorAll('.row')).toHaveLength(2)
    expect(within(gameOver).getByText('7')).toBeInTheDocument()
    expect(within(gameOver).getByText('3')).toBeInTheDocument()
  })

  it('drops malformed result scores before rendering standings', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user'))
    vi.mocked(getSession).mockResolvedValue(ownerRow())
    await renderSession()
    await waitForHandlers()
    handlers.onHeader(
      flappyHeader({
        players: {
          player_0: { kind: 'agent', builtin_name: 'naive', label: 'North' },
          player_1: { kind: 'agent', builtin_name: 'naive', label: 'South' },
          player_2: { kind: 'agent', builtin_name: 'naive', label: 'West' },
          player_3: { kind: 'agent', builtin_name: 'naive', label: 'East' },
        },
        seats: {
          seat_0: ['player_0'],
          seat_1: ['player_1'],
          seat_2: ['player_2'],
          seat_3: ['player_3'],
        },
      }),
    )
    handlers.onState(flappyState(1, 7))
    handlers.onResult?.({
      ticks: 2,
      reason: 'terminated',
      scores: { player_0: 7, player_1: Number.NaN, player_2: '3', player_3: Infinity },
    })
    handlers.onSessionStatus?.('ended', 'terminated')

    const gameOver = await screen.findByRole('dialog', { name: 'Game over' })
    expect(gameOver.querySelectorAll('.row')).toHaveLength(1)
    expect(within(gameOver).getByText('7')).toBeInTheDocument()
    expect(gameOver).not.toHaveTextContent('NaN')
  })

  it('reveals the rating panel above the canvas only after the session ends', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('viewer'))
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
            display_name: 'Agent 1',
            is_own: false,
            author_prompt: 'Judge smoothness.',
            your_rating: null,
          },
        ],
      },
    })
    await renderSession()
    await waitForHandlers()
    expect(screen.queryByText('Rate the Agents')).toBeNull()

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
    expect(screen.queryByRole('dialog', { name: 'Game over' })).toBeNull()
  })

  it('prompts an anonymous viewer to sign in to rate an ended session, without reading ratings', async () => {
    // A signed-out spectator may watch a public session through its end, so instead of the rating panel
    // (or a redirect) they see a sign-in prompt. The protected ratings read must never fire for them.
    vi.mocked(getMe).mockResolvedValue(anonymousMe)
    vi.mocked(getSession).mockResolvedValue(endedOwnerRow())
    await renderSession()

    const signIn = await screen.findByRole('link', { name: 'Sign in' })
    expect(signIn).toHaveAttribute('href', '/login')
    expect(signIn).toHaveClass('sign-in-link')
    expect(signIn.parentElement?.firstElementChild).toBe(signIn)
    expect(signIn.parentElement).toHaveTextContent('Sign in to rate the agents in this session.')
    // The panel never mounts for an anonymous viewer, so its self-fetch never runs.
    expect(screen.queryByTestId('ratings-reveal')).toBeNull()
    expect(vi.mocked(getSessionRatings)).not.toHaveBeenCalled()
  })

  it('masks playable submitted-agent attribution for non-operators', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('viewer'))
    vi.mocked(getSession).mockResolvedValue(scriptedRow())
    vi.mocked(listSeasons).mockResolvedValue([
      {
        id: 'flappy_bird-iter-1',
        env_id: 'flappy_bird',
        submission_status: 'closed',
        play_status: 'open',
        release_status: 'unreleased',
        label: 'Playground',
        description_markdown: null,
        created_at: '2026-06-11T00:00:00.000Z',
        released_at: null,
        submission_count: 1,
        game_count: 0,
      },
    ])
    // The attribution must number the agent the same way the rating panel does, so a blind viewer
    // sees one consistent "Agent N" across both surfaces.
    vi.mocked(watchAgentNumbers).mockResolvedValue({ 'sub-maya': 1 })
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
    const attribution = await screen.findByText('Agent 1')
    expect(attribution).toBeInTheDocument()
    expect(screen.queryByText("maya-fledgling's agent")).toBeNull()
    // The masked row's identity is hidden outright, so no id tooltip rides along either.
    expect(attribution).not.toHaveAttribute('title')
  })

  it("keeps the viewer's own masked-label submitted agent identified by an id tooltip while blind", async () => {
    // "Your agent" still names the viewer's own seat (not the real label), but the plan requires the
    // stable id stay reachable for the viewer's own rows even while blind masks everyone else's.
    vi.mocked(getMe).mockResolvedValue(signedInMe('maya-fledgling'))
    vi.mocked(getSession).mockResolvedValue(scriptedRow())
    vi.mocked(listSeasons).mockResolvedValue([
      {
        id: 'flappy_bird-iter-1',
        env_id: 'flappy_bird',
        submission_status: 'closed',
        play_status: 'open',
        release_status: 'unreleased',
        label: 'Playground',
        description_markdown: null,
        created_at: '2026-06-11T00:00:00.000Z',
        released_at: null,
        submission_count: 1,
        game_count: 0,
      },
    ])
    vi.mocked(watchAgentNumbers).mockResolvedValue({ 'sub-maya': 1 })
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
    const attribution = await screen.findByText('Your agent')
    expect(attribution).toHaveAttribute('title', 'maya-fledgling')
  })

  it('reveals submitted-agent attribution after public play closes', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('viewer'))
    vi.mocked(getSession).mockResolvedValue(scriptedRow())
    vi.mocked(listSeasons).mockResolvedValue([
      {
        id: 'flappy_bird-iter-1',
        env_id: 'flappy_bird',
        submission_status: 'closed',
        play_status: 'closed',
        release_status: 'released',
        label: 'Playground',
        description_markdown: null,
        created_at: '2026-06-11T00:00:00.000Z',
        released_at: '2026-06-12T00:00:00.000Z',
        submission_count: 1,
        game_count: 0,
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
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user'))
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
    const view = await renderSession()

    // A naturally-ended session shows the shared game-over leaderboard over the hydrated final frame;
    // the status badge separately names the end reason. Scope the run facts to the status row so the
    // score there isn't confused with the same score on the leaderboard card.
    expect(await screen.findByRole('dialog', { name: 'Game over' })).toBeInTheDocument()
    expect(handlers).toBeUndefined()
    const statusBar = view.container.querySelector('.session-status') as HTMLElement
    expect(within(statusBar).getByText('Game over')).toBeInTheDocument()
    // Mode/owner are gone; the run facts now sit inline in the status row as Score/Ticks/Started.
    expect(within(statusBar).getByText('Score')).toBeInTheDocument()
    expect(within(statusBar).getByText('22')).toBeInTheDocument()
    // Pin state is conveyed by the button alone now, not a duplicate metadata row.
    expect(await screen.findByRole('button', { name: 'Pinned ✓' })).toBeInTheDocument()
    expect(mountCtx?.controlledPlayers).toEqual([])
    expect(mountCtx?.sendAction).toBeUndefined()
    expect(drawn.at(-1)).toMatchObject({ tick: 2 })
  })

  it('rebuilds complete standings for a directly opened ended session', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user'))
    vi.mocked(getSession).mockResolvedValue(endedOwnerRow())
    const players = {
      player_0: { kind: 'agent' as const, builtin_name: 'naive', label: 'North' },
      player_1: { kind: 'agent' as const, builtin_name: 'naive', label: 'South' },
    }
    vi.mocked(getRecording).mockResolvedValue(
      recordingText(
        [
          {
            schema_version: 1,
            tick: 0,
            agents: {
              player_0: { reward: 7, score: 7, action: 0 },
              player_1: { reward: 0, score: 0, action: 1 },
            },
            timing: { started_at: 0, duration_ms: 1 },
          },
          {
            schema_version: 1,
            tick: 1,
            agents: { player_1: { reward: 3, score: 3, action: 1 } },
            timing: { started_at: 1, duration_ms: 1 },
          },
        ],
        {
          players,
          seats: { seat_0: ['player_0'], seat_1: ['player_1'] },
        },
      ),
    )

    await renderSession()

    const gameOver = await screen.findByRole('dialog', { name: 'Game over' })
    expect(gameOver.querySelectorAll('.row')).toHaveLength(2)
    expect(within(gameOver).getByText('7')).toBeInTheDocument()
    expect(within(gameOver).getByText('3')).toBeInTheDocument()
  })

  it('gives a spectator no controls and no input', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('someone-else'))
    vi.mocked(getSession).mockResolvedValue(ownerRow())
    await renderSession()
    await waitForHandlers()
    handlers.onHeader(HEADER)
    handlers.onSessionStatus?.('running')

    expect(mountCtx?.controlledPlayers).toEqual([])
    expect(mountCtx?.sendAction).toBeUndefined()
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('shows a loading indicator until the renderer mounts, not the decision-log disclosure', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user'))
    vi.mocked(getSession).mockResolvedValue(ownerRow())
    await renderSession()
    await waitForHandlers()

    // The socket is connected but no header has arrived: the renderer has not mounted, so the stage
    // shows the loading indicator and never the "Decision log" disclosure it has no rows for.
    expect(await screen.findByText('Loading session…')).toBeInTheDocument()
    expect(screen.queryByText('Decision log')).toBeNull()

    // The header mounts the renderer; the loading indicator clears.
    handlers.onHeader(HEADER)
    await waitFor(() => expect(screen.queryByText('Loading session…')).toBeNull())
  })

  it('buffers a watch run through the jitter buffer and reveals game over only after it drains', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('viewer'))
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

      // The last frame starts its cadence-long transition, so game over remains held for one more tick.
      vi.advanceTimersByTime(50)
      await nextTick()
      expect(drawn).toHaveLength(3)
      expect(screen.queryByRole('dialog', { name: 'Game over' })).toBeNull()
      vi.advanceTimersByTime(50)
      await nextTick()
      // The held end is revealed: both the status badge (reasonText) and the new game-over
      // leaderboard card show, so disambiguate to the card and check the held result fact.
      const gameOver = screen.getByRole('dialog', { name: 'Game over' })
      expect(gameOver).toBeInTheDocument()
      expect(within(gameOver).getByText('7')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the first held result when a buffered stream sends a duplicate', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('viewer'))
    vi.mocked(getSession).mockResolvedValue(scriptedRow())
    const view = await renderSession()
    await waitForHandlers()

    vi.useFakeTimers()
    try {
      handlers.onHeader(HEADER)
      handlers.onState(flappyState(0, 1))
      handlers.onState(flappyState(1, 2))
      handlers.onState(flappyState(2, 3))
      handlers.onResult?.({ ticks: 42, reason: 'terminated', scores: { player_0: 7 } })
      handlers.onResult?.({ ticks: 99, reason: 'stopped', scores: { player_0: 99 } })
      handlers.onSessionStatus?.('ended')

      vi.advanceTimersByTime(200)
      await nextTick()

      const gameOver = screen.getByRole('dialog', { name: 'Game over' })
      expect(within(gameOver).getByText('7')).toBeInTheDocument()
      expect(within(gameOver).queryByText('99')).toBeNull()
      const statusBar = view.container.querySelector('.session-status') as HTMLElement
      expect(within(statusBar).getByText('Game over')).toBeInTheDocument()
      expect(within(statusBar).getByText('42')).toBeInTheDocument()
      expect(within(statusBar).queryByText('Stopped')).toBeNull()
      expect(within(statusBar).queryByText('99')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows a waiting indicator when the jitter buffer underruns, and clears it when frames resume', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('viewer'))
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

  it('throttles a live human turn-based session: own move instant, opponents paced, end held until drained', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user'))
    // A live human Hearts session: turn-based, owner controls a seat, env declares a 900 ms live cadence.
    vi.mocked(getSession).mockResolvedValue({ ...ownerRow(), env_id: 'hearts' })
    vi.mocked(getEnvironments).mockResolvedValue([heartsMeta()])
    await renderSession()
    await waitForHandlers()

    vi.useFakeTimers()
    try {
      handlers.onHeader(flappyHeader({ environment: 'hearts' }))
      handlers.onSessionStatus?.('running')

      // Leading edge: the first frame after the idle gap (the deal, or the human's own move) draws at
      // once, at the renderer's natural duration (no transition budget) — immediate input feedback.
      handlers.onState(flappyState(0, 0))
      await nextTick()
      expect(drawn).toHaveLength(1)
      expect(drawnOptions.at(-1)).toBeUndefined()

      // A burst of three opponent replies arrives while the throttle window is open: they queue, and
      // nothing new draws until the cadence ticks — the fix for "all play together".
      handlers.onState(flappyState(1, 0))
      handlers.onState(flappyState(2, 0))
      handlers.onState(flappyState(3, 0))
      await nextTick()
      expect(drawn).toHaveLength(1)

      // The stream ends mid-burst; game over stays hidden until the queued moves have played out.
      handlers.onResult?.({ ticks: 4, reason: 'terminated', scores: { player_0: 3 } })
      handlers.onSessionStatus?.('ended', 'terminated')

      // Each cadence tick plays exactly one queued move, with the cadence as its transition budget so
      // the renderer animates it rather than snapping.
      vi.advanceTimersByTime(900)
      await nextTick()
      expect(drawn).toHaveLength(2)
      expect(drawnOptions.at(-1)).toEqual({ transitionMs: 900 })
      expect(screen.queryByText('Game over')).toBeNull()

      vi.advanceTimersByTime(900)
      await nextTick()
      expect(drawn).toHaveLength(3)

      // The last queued move draws; the end is still held (revealed only once the queue is empty).
      vi.advanceTimersByTime(900)
      await nextTick()
      expect(drawn).toHaveLength(4)
      expect(screen.queryByText('Game over')).toBeNull()

      // The next tick finds the queue empty and reveals game over (held until the last move drew).
      vi.advanceTimersByTime(900)
      await nextTick()
      expect(screen.getByRole('dialog', { name: 'Game over' })).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('applies the newest chat policy before a throttled opponent state renders', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user'))
    vi.mocked(getSession).mockResolvedValue(spadesOwnerRow())
    vi.mocked(getEnvironments).mockResolvedValue([spadesMeta()])
    await renderSession()
    await waitForHandlers()

    vi.useFakeTimers()
    try {
      handlers.onHeader(spadesHeader())
      handlers.onSessionStatus?.('running')
      handlers.onConnectionChange?.('open')
      handlers.onState(
        playerState(0, {
          chatOptions: {
            sender: 'player_0',
            target_recipients: ['player_2'],
            default_recipient: 'player_2',
          },
        }),
      )
      await nextTick()

      const input = screen.getByRole('textbox') as HTMLInputElement
      await fireEvent.update(input, 'keep this draft')
      expect(screen.getByRole('combobox')).toHaveValue('player_2')
      expect(drawn).toHaveLength(1)

      // This opponent frame remains visually queued for the live cadence, but its chat policy is
      // transport authority and must take effect immediately.
      handlers.onState(
        playerState(1, {
          chatOptions: {
            sender: 'player_0',
            target_recipients: ['player_1'],
            default_recipient: 'player_1',
          },
        }),
      )
      await nextTick()

      expect(drawn).toHaveLength(1)
      expect(screen.getByRole('combobox')).toHaveValue('player_1')
      expect(input.value).toBe('keep this draft')
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows "No such session" when the row is missing', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user'))
    vi.mocked(getSession).mockResolvedValue(undefined)
    await renderSession()
    expect(await screen.findByText('No such session.')).toBeInTheDocument()
  })

  it('keeps chat available across actions and ordinary state changes', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user'))
    vi.mocked(getEnvironments).mockResolvedValue([spadesMeta()])
    vi.mocked(getSession).mockResolvedValue(spadesOwnerRow())
    await renderSession()
    await waitForHandlers()
    handlers.onHeader(spadesHeader())
    handlers.onSessionStatus?.('running')
    handlers.onConnectionChange?.('open')
    handlers.onState(
      playerState(7, {
        chatOptions: {
          sender: 'player_1',
          target_recipients: ['player_3'],
          default_recipient: 'player_3',
        },
      }),
    )
    await nextTick()
    expect(screen.queryByRole('textbox')).toBeNull()
    handlers.onState(
      playerState(8, {
        chatOptions: {
          sender: 'player_0',
          target_recipients: ['player_2', 'player_1'],
          default_recipient: 'player_2',
        },
      }),
    )

    const input = await screen.findByRole('textbox')
    await fireEvent.update(input, 'lead low')
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(sent).toContainEqual({
      kind: 'chat',
      player: 'player_0',
      to: 'player_2',
      text: 'lead low',
    })

    await fireEvent.update(input, 'draft across opponent turns')
    mountCtx?.sendAction?.('player_0', 12)
    await nextTick()
    expect(sent).toContainEqual({ kind: 'input', player: 'player_0', action: 12 })
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(
      'draft across opponent turns',
    )

    handlers.onState(
      playerState(12, {
        chatOptions: {
          sender: 'player_0',
          target_recipients: ['player_2'],
          default_recipient: 'player_2',
        },
      }),
    )
    const nextInput = (await screen.findByRole('textbox')) as HTMLInputElement
    expect(nextInput.value).toBe('draft across opponent turns')
  })

  it('restores the preserved chat draft after reconnect and never consumes it on an action', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user'))
    vi.mocked(getEnvironments).mockResolvedValue([spadesMeta()])
    vi.mocked(getSession).mockResolvedValue(spadesOwnerRow())
    await renderSession()
    await waitForHandlers()
    handlers.onHeader(spadesHeader())
    handlers.onSessionStatus?.('running')
    handlers.onState(
      playerState(3, {
        chatOptions: {
          sender: 'player_0',
          target_recipients: ['player_2'],
          default_recipient: null,
        },
      }),
    )
    handlers.onConnectionChange?.('open')

    const input = (await screen.findByRole('textbox')) as HTMLInputElement
    await fireEvent.update(input, 'lead low')

    // A disconnected composer is unavailable, but the mounted panel retains its draft.
    handlers.onConnectionChange?.('reconnecting')
    await nextTick()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(sent).toHaveLength(0)

    // Renderer input still fails closed while the socket is unavailable.
    mountCtx?.sendAction?.('player_0', 12)
    await nextTick()
    expect(sent).toHaveLength(0)

    // The latest self-contained policy reactivates the composer with the unsent draft.
    handlers.onConnectionChange?.('open')
    await nextTick()
    const restored = screen.getByRole('textbox') as HTMLInputElement
    expect(restored.value).toBe('lead low')
    mountCtx?.sendAction?.('player_0', 12)
    await nextTick()
    expect(sent).toContainEqual({
      kind: 'input',
      player: 'player_0',
      action: 12,
    })
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    expect(restored.value).toBe('lead low')
  })

  it('keys the character counter off the row cap, not the metadata', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user'))
    // Metadata caps at 120; the row's effective block (a season override) tightened it to 5.
    vi.mocked(getEnvironments).mockResolvedValue([spadesMeta()])
    vi.mocked(getSession).mockResolvedValue({ ...spadesOwnerRow(), message_cap: 5 })
    await renderSession()
    await waitForHandlers()
    handlers.onHeader(spadesHeader())
    handlers.onSessionStatus?.('running')
    handlers.onConnectionChange?.('open')
    handlers.onState(
      playerState(4, {
        chatOptions: {
          sender: 'player_0',
          target_recipients: ['player_2'],
          default_recipient: 'player_2',
        },
      }),
    )

    const input = await screen.findByRole('textbox')
    await fireEvent.update(input, 'hello') // 5 code points: exactly the row cap
    expect(screen.getByText('5/5')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
    await fireEvent.update(input, 'hello!') // 6: over the row cap
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('accumulates chat messages paced with their frames', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('viewer'))
    vi.mocked(getEnvironments).mockResolvedValue([spadesMeta({ view_interval_ms: 50 })])
    vi.mocked(getSession).mockResolvedValue({
      ...scriptedRow(),
      env_id: 'spades',
      recording_id: 'spades-s1',
      messaging_enabled: 1,
      message_cap: 120,
    })
    await renderSession()
    await waitForHandlers()

    vi.useFakeTimers()
    try {
      handlers.onHeader(spadesHeader())
      handlers.onState(playerState(0))
      handlers.onState(
        playerState(1, { messages: [{ from: 'player_0', to: null, text: 'hello table' }] }),
      )
      // Below the lead (150 ms / 50 ms = 3 frames): nothing has drained, so the message is not shown.
      vi.advanceTimersByTime(200)
      await nextTick()
      expect(drawn).toHaveLength(0)
      expect(screen.queryByText('hello table')).toBeNull()

      // A third frame fills the lead; playout begins and the first tick drains frame 0 (no message).
      handlers.onState(playerState(2))
      vi.advanceTimersByTime(50)
      await nextTick()
      expect(drawn).toHaveLength(1)
      expect(screen.queryByText('hello table')).toBeNull()

      // The next tick drains frame 1, which carries the message: only now does it render.
      vi.advanceTimersByTime(50)
      await nextTick()
      expect(drawn).toHaveLength(2)
      expect(screen.getByText('hello table')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not duplicate a re-received message when the latest state line replays', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user'))
    // live_interval_ms null keeps the human stream unbuffered, so onState renders on arrival.
    vi.mocked(getEnvironments).mockResolvedValue([spadesMeta({ live_interval_ms: null })])
    vi.mocked(getSession).mockResolvedValue(spadesOwnerRow())
    await renderSession()
    await waitForHandlers()
    handlers.onHeader(spadesHeader())
    handlers.onSessionStatus?.('running')

    const line = playerState(5, { messages: [{ from: 'player_0', to: null, text: 'hello table' }] })
    handlers.onState(line)
    handlers.onState(line) // attach/reconnect replays the relay's latest state line
    expect(await screen.findAllByText('hello table')).toHaveLength(1)

    // Accumulation resumes cleanly after the duplicate.
    handlers.onState(playerState(6, { messages: [{ from: 'player_1', to: null, text: 'my bid' }] }))
    expect(await screen.findByText('my bid')).toBeInTheDocument()
    expect(screen.getAllByText('hello table')).toHaveLength(1)
  })

  it('hydrates the full chat log from the recording on a reopened ended session', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user'))
    vi.mocked(getEnvironments).mockResolvedValue([spadesMeta()])
    vi.mocked(getSession).mockResolvedValue({
      ...endedOwnerRow(),
      env_id: 'spades',
      recording_id: 'spades-s1',
      messaging_enabled: 1,
      message_cap: 120,
    })
    vi.mocked(getRecording).mockResolvedValue(
      recordingText(
        [
          playerState(0, { messages: [{ from: 'player_0', to: null, text: 'good luck' }] }),
          playerState(1, { messages: [{ from: 'player_1', to: 'player_3', text: 'cover me' }] }),
        ],
        { environment: 'spades', players: spadesPlayers() },
      ),
    )
    await renderSession()

    // The full exchange renders from the parsed recording, with no live socket and no composer.
    expect(await screen.findByText('good luck')).toBeInTheDocument()
    expect(screen.getByText('cover me')).toBeInTheDocument()
    expect(handlers).toBeUndefined()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('keeps the viewer’s own messages badged on an ended session', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user'))
    vi.mocked(getEnvironments).mockResolvedValue([spadesMeta()])
    vi.mocked(getSession).mockResolvedValue({
      ...endedOwnerRow(),
      env_id: 'spades',
      recording_id: 'spades-s1',
      messaging_enabled: 1,
      message_cap: 120,
    })
    vi.mocked(getRecording).mockResolvedValue(
      recordingText(
        [
          playerState(0, { messages: [{ from: 'player_2', to: null, text: 'good luck all' }] }),
          playerState(1, { messages: [{ from: 'player_0', to: 'player_2', text: 'nice bid' }] }),
        ],
        { environment: 'spades', players: spadesPlayers('player_2') },
      ),
    )
    await renderSession()

    // Seat identity is the viewer's role in the match, not a live-control affordance, so it survives the
    // session ending: their own line stays "from you" and the line to them stays "to you", even though
    // control (and the composer) are gone.
    expect(await screen.findByText('from you')).toBeInTheDocument()
    expect(screen.getByText('to you')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('shows a spectator the chat panel without a composer', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('someone-else'))
    vi.mocked(getEnvironments).mockResolvedValue([spadesMeta()])
    vi.mocked(getSession).mockResolvedValue(spadesOwnerRow()) // owned by dev-user
    await renderSession()
    await waitForHandlers()
    handlers.onHeader(spadesHeader())
    handlers.onSessionStatus?.('running')
    handlers.onState(
      playerState(1, { messages: [{ from: 'player_0', to: null, text: 'table talk' }] }),
    )

    expect(await screen.findByText('table talk')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('mounts no chat panel when the season override disabled messaging', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user'))
    // The metadata enables messaging, but the row's effective block (a season override) disabled it.
    vi.mocked(getEnvironments).mockResolvedValue([spadesMeta()])
    vi.mocked(getSession).mockResolvedValue({ ...spadesOwnerRow(), messaging_enabled: 0 })
    await renderSession()
    await waitForHandlers()
    handlers.onHeader(spadesHeader())
    handlers.onSessionStatus?.('running')
    handlers.onState(
      playerState(1, { messages: [{ from: 'player_0', to: null, text: 'silenced' }] }),
    )
    await nextTick()

    expect(screen.queryByText('silenced')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})
