import type { ModelAlias } from '@game-sandbox/schema/llm'
import type OpenAI from 'openai'

/** The stable model names agent code is allowed to observe, shared with the frontend. */
export { MAX_LLM_COST_WEIGHT, MODEL_ALIASES, type ModelAlias } from '@game-sandbox/schema/llm'

/** Deployment-private metadata for one stable public model alias. */
export interface LlmModelConfig {
  upstream: string
  costWeight: number
}

/** Successful usage accumulated by one accounting scope. */
export interface LlmUsage {
  calls: number
  inputTokens: number
  reasoningTokens: number
  outputTokens: number
}

/** Durable usage grouped by stored model name, including retired or unexpected aliases. */
export type LlmCommittedUsageByModel = Partial<Record<ModelAlias, LlmUsage>> &
  Record<string, LlmUsage | undefined>

/** Successful-call limits with pending admission capacity for one generic accounting scope. */
export interface LlmLimits {
  tokenBudget: number
  requestsPerMinute: number
}

export type MaybePromise<T> = T | Promise<T>

/** One independently enforced meter, such as a session slot or a development key. */
export interface LlmAccountingScope {
  key: string
  limits: LlmLimits
  /** Token-budget cost for each model alias enabled on this scope. */
  weights: Partial<Record<ModelAlias, number>>
  /** Must synchronously read the durable store written by this grant's record sink. */
  readCommittedUsage: () => LlmCommittedUsageByModel
}

/** The identity-free successful result handed to a grant's durable sink. */
export interface LlmSuccessfulRecord {
  model: ModelAlias
  /** The grant-resolved alias price that admitted this call. */
  costWeight: number
  /** Authoritative weighted units charged for this successful call. */
  budgetCostUnits: number
  request: Record<string, unknown>
  completion: OpenAI.Chat.Completions.ChatCompletion
  usage: Omit<LlmUsage, 'calls'>
  usageEstimated: boolean
  latencyMs: number
}

/** Durable recording and write-health operations supplied by an authenticated grant. */
export interface LlmRecordSink {
  record: (record: LlmSuccessfulRecord) => MaybePromise<void>
  probeHealth: () => MaybePromise<void>
}

/**
 * Everything the shared handler needs after authentication, without official identity fields.
 * Grant construction must bind the scope reader to committed usage written by `recordSink`.
 */
export interface LlmGrant {
  kind: 'official' | 'development'
  models: Partial<Record<ModelAlias, LlmModelConfig>>
  accountingScope: LlmAccountingScope
  recordSink: LlmRecordSink
}

/** Mutable hook phase captured by an official telemetry sink and key-registry entry. */
export interface OfficialTickMarkerRef {
  current: number | null
}

export interface OfficialKeyEntry {
  sessionId: string
  grant: LlmGrant
  tick: OfficialTickMarkerRef
}

export type LlmChatRequest = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
export type LlmChatCompletion = OpenAI.Chat.Completions.ChatCompletion

export function totalTokens(usage: Omit<LlmUsage, 'calls'>): number {
  // OpenAI completion_tokens includes its reasoning subset, so never add reasoning twice.
  return usage.inputTokens + usage.outputTokens
}

/** Project a grant's model metadata onto the per-alias token prices its accounting scope enforces. */
export function modelCostWeights(
  models: Partial<Record<ModelAlias, LlmModelConfig>>,
): Partial<Record<ModelAlias, number>> {
  return Object.fromEntries(
    Object.entries(models).map(([alias, model]) => [alias, model.costWeight]),
  ) as Partial<Record<ModelAlias, number>>
}

/**
 * Weighted successful tokens committed across every model in an accounting scope.
 * A durable row whose alias is no longer configured uses the highest price in the current scope as
 * a conservative fallback among the models that scope can still use.
 */
export function weightedCommittedTokens(
  byModel: LlmCommittedUsageByModel,
  weights: Partial<Record<ModelAlias, number>>,
): number {
  const configured = Object.values(weights)
  if (configured.length === 0) {
    throw new Error('LLM accounting scope needs at least one model cost weight')
  }
  const fallback = Math.max(...configured)
  return Object.entries(byModel).reduce((sum, [model, usage]) => {
    if (usage === undefined) return sum
    const configuredWeight = Object.hasOwn(weights, model)
      ? weights[model as ModelAlias]
      : undefined
    return sum + (configuredWeight ?? fallback) * totalTokens(usage)
  }, 0)
}
