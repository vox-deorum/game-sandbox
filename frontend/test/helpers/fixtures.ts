/**
 * Shared test fixtures, deduplicated from the suites (see plans/stage-04.5/testing-and-docs.md). The
 * Flappy Bird environment metadata appeared verbatim in six files; the recording builders in two. Each
 * factory returns a fresh object and takes overrides, so a suite tweaks only what it asserts on.
 */
import type { AgentStep, RecordingHeader, StepState } from '@game-sandbox/schema'
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
    ...overrides,
  }
}

/** A recording header for a Flappy Bird run (schema version 1). */
export function flappyHeader(overrides: Partial<RecordingHeader> = {}): RecordingHeader {
  return { schema_version: 1, environment: 'flappy_bird', seed: 0, ...overrides }
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
 * A JSONL recording string: a header line then one line per state. `schemaVersion` is loose (a number)
 * so a suite can build a deliberately-unsupported version to exercise the viewer's version check.
 */
export function recordingText(
  states: StepState[],
  opts: { schemaVersion?: number; environment?: string; seed?: number } = {},
): string {
  const header = {
    schema_version: opts.schemaVersion ?? 1,
    environment: opts.environment ?? 'flappy_bird',
    seed: opts.seed ?? 0,
  }
  return `${[JSON.stringify(header), ...states.map((s) => JSON.stringify(s))].join('\n')}\n`
}
