import type { LlmOptions } from '../../src/config/config.js'
import { EnvironmentRegistry } from '../../src/environments/registry.js'
import type { ResolvedOfficialLlmPolicy } from '../../src/llm/config.js'

/** Explicit disabled policy for storage-focused tests that do not exercise LLM resolution. */
export const TEST_DISABLED_OFFICIAL_LLM_POLICY: ResolvedOfficialLlmPolicy = {
  enabled: false,
  models: {},
  session: { token_budget: 100_000, rate_limit_rpm: 60 },
}

/**
 * A field-complete, LLM-enabled environment metadata entry, overridable. The default is the
 * `llm_env` fixture the development LLM API, key, and integration suites all share: single seat,
 * no messaging, sequential stepping.
 */
export function llmMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    env_id: 'llm_env',
    display_name: 'LLM Environment',
    description: 'test env',
    builtin_agents: [{ name: 'naive', label: 'Naive agent' }],
    layout: { kind: 'player_bounds', min: 1, max: 1 },
    human_players: [],
    human_timeout_ms: null,
    recommended_episode_ticks: 100,
    pace_interval_ms: null,
    stepping: 'sequential',
    step_limit_ms: 1_000,
    episode_limit_ms: 60_000,
    messaging: false,
    message_cap: null,
    llm: true,
    renderer: 'test',
    seat_order_matters: false,
    view_interval_ms: null,
    live_interval_ms: null,
    parameters: [
      {
        name: 'players',
        title: 'Players',
        description: 'Number of players.',
        type: 'int',
        default: 1,
        min: 1,
        max: 1,
      },
    ],
    ...overrides,
  }
}

/**
 * A registry with the shared `llm_env` fixture, plus any extra environment entries (e.g. a second
 * season's environment) the caller supplies.
 */
export function llmEnvironments(...extra: Array<Record<string, unknown>>): EnvironmentRegistry {
  return EnvironmentRegistry.parse(JSON.stringify([llmMeta(), ...extra]))
}

/** Build the LLM proxy configuration shared by backend test stacks. */
export function makeTestLlmOptions(): LlmOptions {
  return {
    internalPort: 8_081,
    models: {},
    upstreamTimeoutMs: 30_000,
    upstreamMaxRetries: 2,
    tiktokenEncoding: 'cl100k_base',
    defaultMaxOutputTokens: 1_024,
    maxOutputTokens: 4_096,
    sessionLimits: { tokenBudget: 100_000, requestsPerMinute: 60 },
    developmentLimits: { tokenBudget: 100_000, requestsPerMinute: 30 },
  }
}
