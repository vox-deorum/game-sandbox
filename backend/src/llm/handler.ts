import { invalidRequest, LlmError } from './errors.js'
import type { LlmMeter } from './meter.js'
import type { LlmTokenCounter } from './tokenizer.js'
import type { LlmChatCompletion, LlmChatRequest, LlmGrant, ModelAlias } from './types.js'
import { MODEL_ALIASES } from './types.js'
import type { UpstreamCaller, UpstreamSuccess } from './upstream.js'
import { UpstreamError } from './upstream.js'
import { resolveUsage } from './usage.js'

export interface LlmHandlerOptions {
  defaultMaxOutputTokens: number
  maxOutputTokens: number
}

export interface LlmHandlerDeps {
  meter: LlmMeter
  tokenizer: LlmTokenCounter
  upstream: Pick<UpstreamCaller, 'call'>
  options: LlmHandlerOptions
}

export interface LlmRequestLifecycle {
  signal: AbortSignal
  beginFinalization(): void
}

/** The identity-free chat-completion path shared by official and later development routes. */
export class LlmHandler {
  constructor(private readonly deps: LlmHandlerDeps) {}

  async handle(
    grant: LlmGrant,
    body: unknown,
    lifecycle?: LlmRequestLifecycle,
  ): Promise<LlmChatCompletion> {
    const request = requestObject(body)
    const alias = allowedAlias(grant, request.model)
    if (Object.hasOwn(request, 'stream') && request.stream !== false) {
      throw invalidRequest('streaming_unsupported', 'Streaming chat completions are not supported.')
    }
    const { accepted, upstream } = normalizeMaximum(
      request,
      this.deps.options.defaultMaxOutputTokens,
      this.deps.options.maxOutputTokens,
    )
    accepted.model = alias
    upstream.model = grant.models[alias] as string

    const inputTokens = this.deps.tokenizer.countRequest(accepted)
    const outputTokens = enforcedMaximum(accepted)
    const reservation = await this.deps.meter.reserve(
      grant.accountingScope,
      inputTokens,
      outputTokens,
    )

    let result: UpstreamSuccess
    try {
      const upstreamRequest = upstream as unknown as LlmChatRequest
      result =
        lifecycle === undefined
          ? await this.deps.upstream.call(upstreamRequest)
          : await this.deps.upstream.call(upstreamRequest, lifecycle.signal)
      // Once provider spend exists, cancellation would lose accounting. Revocation drains from here.
      lifecycle?.beginFinalization()
    } catch (error) {
      this.deps.meter.release(reservation)
      if (lifecycle?.signal.aborted === true) {
        throw new LlmError(
          503,
          'request_cancelled',
          'The session ended before the request completed.',
          'server_error',
        )
      }
      throw redactUpstreamModel(error, upstream.model as string, alias)
    }

    try {
      const completion = redactCompletion(result.completion, alias)
      const resolved = resolveUsage(accepted, completion, this.deps.tokenizer)
      await this.deps.meter.commit(reservation, grant.recordSink, {
        model: alias,
        request: accepted,
        completion,
        usage: resolved.usage,
        usageEstimated: resolved.estimated,
        latencyMs: result.latencyMs,
      })
      return completion
    } catch (error) {
      // A sink failure already converted the reservation to debt inside commit. Any other failure
      // after upstream success must do the same because the provider has already consumed spend.
      if (reservation.active) {
        this.deps.meter.chargeConservativeDebt(reservation, grant.recordSink)
        throw new LlmError(503, 'meter_unavailable', 'Usage accounting is temporarily unavailable.')
      }
      throw error
    }
  }
}

function redactCompletion(completion: LlmChatCompletion, alias: ModelAlias): LlmChatCompletion {
  // Keep the standard semantic payload while dropping provider-specific top-level metadata. Generated
  // text and tool arguments are opaque model output and must never be rewritten as redaction metadata.
  const redacted: LlmChatCompletion = {
    id: completion.id,
    choices: completion.choices,
    created: completion.created,
    model: alias,
    object: completion.object,
  }
  if (completion.moderation !== undefined) {
    redacted.moderation =
      completion.moderation === null ? null : redactModeration(completion.moderation, alias)
  }
  if (completion.service_tier !== undefined) redacted.service_tier = completion.service_tier
  if (completion.usage !== undefined) redacted.usage = completion.usage
  return redacted
}

function redactModeration(
  moderation: NonNullable<LlmChatCompletion['moderation']>,
  alias: ModelAlias,
): NonNullable<LlmChatCompletion['moderation']> {
  type ModerationSide = (typeof moderation)['input']
  const redactSide = (side: ModerationSide): ModerationSide => {
    if (!('model' in side)) return side
    return {
      ...side,
      model: alias,
      results: side.results.map((result) => ({ ...result, model: alias })),
    }
  }
  return { input: redactSide(moderation.input), output: redactSide(moderation.output) }
}

function redactUpstreamModel(error: unknown, upstreamModel: string, alias: ModelAlias): unknown {
  if (!(error instanceof UpstreamError) || upstreamModel.length === 0) return error
  // Exact substring replacement deliberately favors provider-name secrecy over preserving ambiguous
  // prose when an operator configures a short/common model name.
  const replace = (value: string): string => value.replaceAll(upstreamModel, alias)
  return new UpstreamError(error.status, {
    error: {
      message: replace(error.envelope.error.message),
      type: replace(error.envelope.error.type),
      code: replace(error.envelope.error.code),
    },
  })
}

function requestObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidRequest('invalid_request', 'The request body must be a JSON object.')
  }
  return { ...(body as Record<string, unknown>) }
}

function allowedAlias(grant: LlmGrant, requested: unknown): ModelAlias {
  if (
    typeof requested !== 'string' ||
    !MODEL_ALIASES.includes(requested as ModelAlias) ||
    !Object.hasOwn(grant.models, requested) ||
    typeof grant.models[requested as ModelAlias] !== 'string'
  ) {
    throw invalidRequest('model_not_allowed', 'The requested model alias is not allowed.')
  }
  return requested as ModelAlias
}

function normalizeMaximum(
  request: Record<string, unknown>,
  defaultMaximum: number,
  hardMaximum: number,
): { accepted: Record<string, unknown>; upstream: Record<string, unknown> } {
  const hasLegacy = Object.hasOwn(request, 'max_tokens')
  const hasCompletion = Object.hasOwn(request, 'max_completion_tokens')
  if (hasLegacy && hasCompletion) {
    throw invalidRequest(
      'invalid_max_tokens',
      'Supply either max_tokens or max_completion_tokens, not both.',
    )
  }
  const field = hasLegacy ? 'max_tokens' : 'max_completion_tokens'
  const value = hasLegacy
    ? request.max_tokens
    : hasCompletion
      ? request.max_completion_tokens
      : defaultMaximum
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalidRequest('invalid_max_tokens', `${field} must be a non-negative integer.`)
  }
  if (value > hardMaximum) {
    throw invalidRequest(
      'invalid_max_tokens',
      `${field} exceeds the configured output-token limit.`,
    )
  }
  const accepted = { ...request }
  delete accepted.max_tokens
  delete accepted.max_completion_tokens
  accepted[field] = value
  return { accepted, upstream: { ...accepted } }
}

function enforcedMaximum(request: Record<string, unknown>): number {
  return (request.max_tokens ?? request.max_completion_tokens) as number
}
