import type { LlmOptions } from '../../src/config.js'

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
    sessionLimits: { tokenBudget: 100_000, callBudget: 100, requestsPerMinute: 60 },
  }
}
