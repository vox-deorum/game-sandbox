import type {
  DevelopmentCall,
  DevelopmentParticipantUsage,
} from '../storage/llm/development-ledger/store.js'
import type { LlmUsage, ModelAlias } from './types.js'
import { totalTokens } from './types.js'

export interface DevelopmentUsageSummary {
  successfulCalls: number
  budgetCostUnitsUsed: number
  usageEstimated: boolean
  usageByModel: Record<
    string,
    {
      calls: number
      input_tokens: number
      reasoning_tokens: number
      output_tokens: number
    }
  >
}

export function summarizeDevelopmentUsage(
  usageByModel: Record<string, LlmUsage>,
  weights: Partial<Record<ModelAlias, number>>,
  usageEstimated: boolean,
): DevelopmentUsageSummary {
  let successfulCalls = 0
  let budgetCostUnitsUsed = 0
  const encoded: DevelopmentUsageSummary['usageByModel'] = {}
  for (const [model, usage] of Object.entries(usageByModel)) {
    successfulCalls += usage.calls
    budgetCostUnitsUsed += currentWeight(model, weights) * totalTokens(usage)
    encoded[model] = {
      calls: usage.calls,
      input_tokens: usage.inputTokens,
      reasoning_tokens: usage.reasoningTokens,
      output_tokens: usage.outputTokens,
    }
  }
  return { successfulCalls, budgetCostUnitsUsed, usageEstimated, usageByModel: encoded }
}

export function developmentCallView(
  call: DevelopmentCall,
  weights: Partial<Record<ModelAlias, number>>,
): Record<string, unknown> {
  const costWeight = currentWeight(call.model, weights)
  return {
    id: call.id,
    created_at: call.createdAt,
    model: call.model,
    input_tokens: call.inputTokens,
    reasoning_tokens: call.reasoningTokens,
    output_tokens: call.outputTokens,
    usage_estimated: call.usageEstimated,
    cost_weight: costWeight,
    budget_cost_units: costWeight * (call.inputTokens + call.outputTokens),
    request: call.request,
    completion: call.completion,
  }
}

export function participantTotalView(
  participant: DevelopmentParticipantUsage,
  weights: Partial<Record<ModelAlias, number>>,
  tokenBudget: number,
): Record<string, unknown> {
  const summary = summarizeDevelopmentUsage(
    participant.usageByModel,
    weights,
    participant.usageEstimated,
  )
  return {
    user_id: participant.userId,
    successful_calls: summary.successfulCalls,
    usage_estimated: summary.usageEstimated,
    budget_cost_units_used: summary.budgetCostUnitsUsed,
    budget_cost_units_remaining: Math.max(0, tokenBudget - summary.budgetCostUnitsUsed),
  }
}

function currentWeight(model: string, weights: Partial<Record<ModelAlias, number>>): number {
  const direct = weights[model as ModelAlias]
  if (direct !== undefined) return direct
  const configured = Object.values(weights)
  if (configured.length === 0) {
    throw new Error('LLM development read policy needs at least one model cost weight')
  }
  return Math.max(...configured)
}
