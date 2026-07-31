import type { LlmRecordSink, LlmSuccessfulRecord } from '../../llm/types.js'
import type { ExecutionTelemetryStore } from './execution-telemetry.js'

/** Official identity captured when a session player's grant is constructed. */
export interface OfficialRecordSinkScope {
  scopeId: string
  sessionId: string
  player: string
  tick: number | null
}

/**
 * Bind a generic successful-call sink to one official execution scope and immutable admission tick.
 */
export function createOfficialRecordSink(
  store: ExecutionTelemetryStore,
  scope: OfficialRecordSinkScope,
): LlmRecordSink {
  return (record: LlmSuccessfulRecord): void => {
    store.record(scope.scopeId, {
      sessionId: scope.sessionId,
      player: scope.player,
      tick: scope.tick,
      model: record.model,
      costWeight: record.costWeight,
      budgetCostUnits: record.budgetCostUnits,
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
