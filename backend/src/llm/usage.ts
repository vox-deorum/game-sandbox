import type { LlmTokenCounter } from './tokenizer.js'
import type { LlmChatCompletion, LlmSuccessfulRecord } from './types.js'

export interface ResolvedUsage {
  usage: LlmSuccessfulRecord['usage']
  estimated: boolean
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function exposedReasoningTokens(completion: LlmChatCompletion): number {
  const usage = completion.usage as Record<string, unknown> | null | undefined
  const details = usage?.completion_tokens_details
  if (typeof details !== 'object' || details === null) return 0
  const reasoning = (details as Record<string, unknown>).reasoning_tokens
  return nonNegativeInteger(reasoning) ? reasoning : 0
}

/** Validate provider counts strictly, otherwise estimate the retained public request/completion. */
export function resolveUsage(
  request: Record<string, unknown>,
  completion: LlmChatCompletion,
  counter: LlmTokenCounter,
): ResolvedUsage {
  const raw = completion.usage as Record<string, unknown> | null | undefined
  const prompt = raw?.prompt_tokens
  const completionTotal = raw?.completion_tokens
  const total = raw?.total_tokens
  const reasoning = exposedReasoningTokens(completion)
  if (
    nonNegativeInteger(prompt) &&
    nonNegativeInteger(completionTotal) &&
    nonNegativeInteger(total) &&
    total === prompt + completionTotal &&
    reasoning <= completionTotal
  ) {
    return {
      usage: { inputTokens: prompt, reasoningTokens: reasoning, outputTokens: completionTotal },
      estimated: false,
    }
  }
  return {
    usage: {
      inputTokens: counter.countRequest(request),
      reasoningTokens: reasoning,
      outputTokens: counter.countCompletion(completion as unknown as Record<string, unknown>),
    },
    estimated: true,
  }
}
