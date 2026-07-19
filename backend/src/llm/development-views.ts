import type {
  DevelopmentCall,
  DevelopmentCallPage,
  DevelopmentCallPagination,
  DevelopmentParticipantUsage,
} from '../storage/llm/development-ledger/store.js'
import type { LlmUsage, ModelAlias } from './types.js'
import { totalTokens } from './types.js'

export interface DevelopmentCallView {
  id: number
  created_at: string
  model: string
  input_tokens: number
  reasoning_tokens: number
  output_tokens: number
  usage_estimated: boolean
  cost_weight: number
  budget_cost_units: number
  request: unknown
  completion: unknown
}

export interface DevelopmentCallPageView {
  calls: DevelopmentCallView[]
  next_cursor: number | null
}

export interface DevelopmentParticipantTotalView {
  user_id: string
  successful_calls: number
  usage_estimated: boolean
  budget_cost_units_used: number
  budget_cost_units_remaining: number
}

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
): DevelopmentCallView {
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
    budget_cost_units: costWeight * totalTokens(call),
    request: call.request,
    completion: call.completion,
  }
}

export function developmentCallPageView(
  page: DevelopmentCallPage,
  weights: Partial<Record<ModelAlias, number>>,
): DevelopmentCallPageView {
  return {
    calls: page.calls.map((call) => developmentCallView(call, weights)),
    next_cursor: page.nextCursor,
  }
}

export function participantTotalView(
  participant: DevelopmentParticipantUsage,
  weights: Partial<Record<ModelAlias, number>>,
  tokenBudget: number,
): DevelopmentParticipantTotalView {
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

/** Parse the bounded reverse-id cursor shared by participant and operator call-history routes. */
export function parseDevelopmentPagination(query: {
  cursor?: string
  limit?: string
}): DevelopmentCallPagination | null {
  const limit = query.limit === undefined ? 25 : Number(query.limit)
  const cursor = query.cursor === undefined ? undefined : Number(query.cursor)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return null
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 1)) return null
  return cursor === undefined ? { limit } : { cursor, limit }
}

function currentWeight(model: string, weights: Partial<Record<ModelAlias, number>>): number {
  const direct = weights[model as ModelAlias]
  if (direct !== undefined) return direct
  const configured = Object.values(weights)
  if (configured.length === 0) return 0
  return Math.max(...configured)
}
