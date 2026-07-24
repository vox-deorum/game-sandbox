/**
 * Shared test fixtures, deduplicated from the suites (see plans/stage-04.5/testing-and-docs.md). The
 * Flappy Bird environment metadata appeared verbatim in six files; the recording builders in two. Each
 * factory returns a fresh object and takes overrides, so a suite tweaks only what it asserts on.
 */
import type { AgentStep, Message, RecordingHeader, StepState } from '@game-sandbox/schema'
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'

/** The Flappy Bird environment metadata most suites use. Override per test (e.g. an empty description). */
export function flappyMeta(overrides: Partial<EnvironmentMeta> = {}): EnvironmentMeta {
  return {
    env_id: 'flappy_bird',
    display_name: 'Flappy Bird',
    description: 'A paced single-human clone.',
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
    seat_order_matters: false,
    view_interval_ms: null,
    live_interval_ms: null,
    parameters: [
      {
        name: 'seats',
        title: 'Seats',
        description: 'Players.',
        type: 'int',
        default: 1,
        min: 1,
        max: 1,
      },
      {
        name: 'pipe_gap',
        title: 'Pipe gap',
        description: 'Vertical opening between pipes.',
        type: 'int',
        default: 100,
        min: 60,
        max: 200,
      },
    ],
    ...overrides,
  }
}

/**
 * The Hearts environment metadata: four turn-based seats, every seat human-capable, positional
 * (`seat_order_matters`), with an unpaced move clock. The multi-seat watch/play flows render from it.
 */
export function heartsMeta(overrides: Partial<EnvironmentMeta> = {}): EnvironmentMeta {
  return {
    env_id: 'hearts',
    display_name: 'Hearts',
    description: 'Four-player trick-taking Hearts.',
    min_slots: 4,
    max_slots: 4,
    human_slots: ['player_0', 'player_1', 'player_2', 'player_3'],
    human_timeout_ms: 60_000,
    recommended_episode_ticks: 52,
    pace_interval_ms: null,
    step_limit_ms: 1000,
    episode_limit_ms: 120_000,
    messaging: false,
    message_cap: null,
    llm: false,
    renderer: 'hearts',
    seat_order_matters: true,
    view_interval_ms: 3000,
    live_interval_ms: 900,
    parameters: [
      {
        name: 'seats',
        title: 'Seats',
        description: 'Players.',
        type: 'int',
        default: 4,
        min: 4,
        max: 4,
      },
    ],
    ...overrides,
  }
}

/**
 * The Spades environment metadata: the stage's messaging-enabled environment. Four partnership seats,
 * turn-based (no pace interval), a 120-code-point message cap, mirroring `environments/spades`.
 * The chat panel mounts from `messaging`/`message_cap`, so the messaging suites render from it.
 */
export function spadesMeta(overrides: Partial<EnvironmentMeta> = {}): EnvironmentMeta {
  return {
    env_id: 'spades',
    display_name: 'Spades',
    description: 'Four-player partnership Spades.',
    min_slots: 4,
    max_slots: 4,
    human_slots: ['player_0', 'player_1', 'player_2', 'player_3'],
    human_timeout_ms: 60_000,
    recommended_episode_ticks: 56,
    pace_interval_ms: null,
    step_limit_ms: 1000,
    episode_limit_ms: 120_000,
    messaging: true,
    message_cap: 120,
    llm: false,
    renderer: 'spades',
    seat_order_matters: true,
    view_interval_ms: 3000,
    live_interval_ms: 900,
    parameters: [
      {
        name: 'seats',
        title: 'Seats',
        description: 'Players.',
        type: 'int',
        default: 4,
        min: 4,
        max: 4,
      },
    ],
    ...overrides,
  }
}

/** A recording header for a Flappy Bird run (schema version 1). */
export function flappyHeader(overrides: Partial<RecordingHeader> = {}): RecordingHeader {
  return { schema_version: 1, environment: 'flappy_bird', seed: 0, parameters: {}, ...overrides }
}

/**
 * Four Spades seats keyed by slot id, one a connected human (default player_2), the rest agents. The
 * human seat's `label` defaults to the same string as `user` ('dev'); pass `humanLabel` to diverge them
 * (the display-name label vs. the stable id) for a suite proving the label-over-id rendering preference.
 */
export function spadesPlayers(
  humanSlot: string | null = 'player_2',
  humanLabel = 'dev',
): NonNullable<RecordingHeader['players']> {
  const players: NonNullable<RecordingHeader['players']> = {}
  for (const slot of ['player_0', 'player_1', 'player_2', 'player_3']) {
    players[slot] =
      slot === humanSlot
        ? { kind: 'human', label: humanLabel, user: 'dev' }
        : { kind: 'agent', label: 'Naive agent' }
  }
  return players
}

/** A Spades recording header with per-seat attribution (needed for the chat panel's sender labels). */
export function spadesHeader(overrides: Partial<RecordingHeader> = {}): RecordingHeader {
  return {
    schema_version: 1,
    environment: 'spades',
    seed: 0,
    parameters: {},
    players: spadesPlayers(),
    ...overrides,
  }
}

/** One Flappy Bird step state with a single agent and its cumulative score. */
export function flappyState(tick: number, score = 0): StepState {
  const agent: AgentStep = { reward: 0, score }
  return {
    schema_version: 1,
    tick,
    agents: { player_0: agent },
    timing: { started_at: tick, duration_ms: 1 },
  }
}

/**
 * One four-seat step state, optionally carrying the messages sent on this tick. The messaging suites
 * build recordings and live frames from it; `messages` is omitted (as the wire omits it) when absent.
 */
export function seatState(
  tick: number,
  opts: { messages?: Message[]; score?: number } = {},
): StepState {
  const agents: Record<string, AgentStep> = {}
  for (const slot of ['player_0', 'player_1', 'player_2', 'player_3']) {
    agents[slot] = { reward: 0, score: opts.score ?? 0 }
  }
  const state: StepState = {
    schema_version: 1,
    tick,
    agents,
    timing: { started_at: tick, duration_ms: 1 },
  }
  if (opts.messages !== undefined) {
    state.messages = opts.messages
  }
  return state
}

/**
 * A JSONL recording string: a header line then one line per state. `schemaVersion` is loose (a number)
 * so a suite can build a deliberately-unsupported version to exercise the viewer's version check.
 * `players` seeds the header's per-slot attribution so a replay's chat panel can label senders, and
 * `parameters` the resolved settings a replay shows for the episode.
 */
export function recordingText(
  states: StepState[],
  opts: {
    schemaVersion?: number
    environment?: string
    seed?: number
    parameters?: RecordingHeader['parameters']
    players?: RecordingHeader['players']
  } = {},
): string {
  const header: Record<string, unknown> = {
    schema_version: opts.schemaVersion ?? 1,
    environment: opts.environment ?? 'flappy_bird',
    seed: opts.seed ?? 0,
    parameters: opts.parameters ?? {},
  }
  if (opts.players !== undefined) {
    header.players = opts.players
  }
  return `${[JSON.stringify(header), ...states.map((s) => JSON.stringify(s))].join('\n')}\n`
}
