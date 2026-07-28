import type { LlmRecordSink, LlmSuccessfulRecord } from '../../../llm/types.js'
import type { DevelopmentLedgerStore } from './store.js'

/** Bind the generic handler sink to a participant and season, independent of credential rotation. */
export function createDevelopmentRecordSink(
  store: DevelopmentLedgerStore,
  seasonId: string,
  userId: string,
): LlmRecordSink {
  return (record: LlmSuccessfulRecord): void => {
    store.record(seasonId, {
      userId,
      model: record.model,
      request: record.request,
      completion: record.completion,
      inputTokens: record.usage.inputTokens,
      reasoningTokens: record.usage.reasoningTokens,
      outputTokens: record.usage.outputTokens,
      usageEstimated: record.usageEstimated,
      latencyMs: record.latencyMs,
    })
  }
}
