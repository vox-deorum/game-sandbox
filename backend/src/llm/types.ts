import type OpenAI from 'openai'

/** The stable model names agent code is allowed to observe. */
export const MODEL_ALIASES = ['large', 'medium', 'small'] as const
export type ModelAlias = (typeof MODEL_ALIASES)[number]

/** Successful usage accumulated by one accounting scope. */
export interface LlmUsage {
  calls: number
  inputTokens: number
  reasoningTokens: number
  outputTokens: number
}

/** Successful-call and admitted-request limits for one generic accounting scope. */
export interface LlmLimits {
  tokenBudget: number
  callBudget: number
  requestsPerMinute: number
}

export type MaybePromise<T> = T | Promise<T>

/** One independently enforced meter, such as a session slot or run subject. */
export interface LlmAccountingScope {
  key: string
  limits: LlmLimits
  /** Must synchronously read the durable store written by this grant's record sink. */
  readCommittedUsage: () => LlmUsage
}

/** The identity-free successful result handed to a grant's durable sink. */
export interface LlmSuccessfulRecord {
  model: ModelAlias
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
 * Grant construction must bind every scope reader to committed usage written by `recordSink`.
 */
export interface LlmGrant {
  kind: 'official' | 'development'
  models: Partial<Record<ModelAlias, string>>
  accountingScopes: LlmAccountingScope[]
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

export function emptyUsage(): LlmUsage {
  return { calls: 0, inputTokens: 0, reasoningTokens: 0, outputTokens: 0 }
}

export function totalTokens(usage: Omit<LlmUsage, 'calls'>): number {
  // OpenAI completion_tokens includes its reasoning subset, so never add reasoning twice.
  return usage.inputTokens + usage.outputTokens
}
