import type { LlmOptions } from '../../src/config.js'
import type { ResolvedOfficialLlmPolicy } from '../../src/llm/config.js'

/** Explicit disabled policy for storage-focused tests that do not exercise LLM resolution. */
export const TEST_DISABLED_OFFICIAL_LLM_POLICY: ResolvedOfficialLlmPolicy = {
  enabled: false,
  models: {},
  session: { token_budget: 100_000, rate_limit_rpm: 60 },
}

/** Build the LLM proxy configuration shared by backend test stacks. */
export function makeTestLlmOptions(): LlmOptions {
  return {
    internalPort: 8_081,
    models: {},
    upstreamTimeoutMs: 30_000,
    upstreamMaxRetries: 2,
    upstreamRetryIntervalMs: 250,
    tiktokenEncoding: 'cl100k_base',
    defaultMaxOutputTokens: 1_024,
    maxOutputTokens: 4_096,
    meterRecoveryIntervalMs: 5_000,
    sessionLimits: { tokenBudget: 100_000, requestsPerMinute: 60 },
    developmentLimits: { tokenBudget: 100_000, requestsPerMinute: 30 },
  }
}
