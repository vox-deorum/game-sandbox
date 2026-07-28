import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai'

import { LlmError, type LlmErrorBody } from './errors.js'
import type { LlmChatCompletion, LlmChatRequest } from './types.js'

const SDK_INITIAL_RETRY_DELAY_MS = 500
const SDK_MAX_RETRY_DELAY_MS = 8_000

export interface UpstreamChatClient {
  create(
    request: LlmChatRequest,
    options: { timeout: number; signal?: AbortSignal },
  ): Promise<LlmChatCompletion>
}

export interface UpstreamCallerOptions {
  baseURL: string
  apiKey?: string
  timeoutMs: number
  maxRetries: number
  client?: UpstreamChatClient
  now?: () => number
}

export interface UpstreamSuccess {
  completion: LlmChatCompletion
  latencyMs: number
}

/**
 * Bound one SDK-managed logical request by all attempt timeouts and the default retry-delay ceiling.
 * A longer provider Retry-After value may extend the request, but watchdog credit remains capped.
 */
export function upstreamRequestAllowanceMs(timeoutMs: number, maxRetries: number): number {
  let retryDelayMs = 0
  for (let retry = 0; retry < maxRetries; retry++) {
    retryDelayMs += Math.min(SDK_INITIAL_RETRY_DELAY_MS * 2 ** retry, SDK_MAX_RETRY_DELAY_MS)
  }
  return timeoutMs * (maxRetries + 1) + retryDelayMs
}

/** A final upstream response retains its status and compatible body for the listener. */
export class UpstreamError extends LlmError {
  constructor(
    status: number,
    readonly envelope: LlmErrorBody,
  ) {
    super(status, envelope.error.code, envelope.error.message, envelope.error.type)
    this.name = 'UpstreamError'
  }

  override body(): LlmErrorBody {
    return this.envelope
  }
}

/** One SDK-backed upstream request with SDK-managed retries and a per-request timeout. */
export class UpstreamCaller {
  private readonly client: UpstreamChatClient
  private readonly now: () => number

  constructor(private readonly options: UpstreamCallerOptions) {
    if (options.client !== undefined) {
      this.client = options.client
    } else {
      const sdk = new OpenAI({
        apiKey: options.apiKey ?? 'unused-no-upstream-credential',
        baseURL: options.baseURL,
        maxRetries: options.maxRetries,
        // Some OpenAI-compatible local endpoints are deliberately unauthenticated. The SDK requires
        // an apiKey constructor value, then this explicit null suppresses its generated bearer header.
        ...(options.apiKey === undefined ? { defaultHeaders: { Authorization: null } } : {}),
      })
      this.client = {
        create: (request, requestOptions) =>
          sdk.chat.completions.create(request, requestOptions) as Promise<LlmChatCompletion>,
      }
    }
    this.now = options.now ?? Date.now
  }

  async call(request: LlmChatRequest, signal?: AbortSignal): Promise<UpstreamSuccess> {
    const started = this.now()
    signal?.throwIfAborted()
    try {
      const pending = this.client.create(request, {
        timeout: this.options.timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      })
      const completion = signal === undefined ? await pending : await raceWithAbort(pending, signal)
      return { completion, latencyMs: elapsed(started, this.now()) }
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason
      throw normalizeUpstreamError(error)
    }
  }
}

/** Settle the caller promptly when its lifecycle ends, even while the SDK is in a retry sleep. */
function raceWithAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return Promise.race([pending, aborted]).finally(() => {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  })
}

function normalizeUpstreamError(error: unknown): UpstreamError {
  if (error instanceof APIConnectionTimeoutError) {
    return new UpstreamError(502, {
      error: {
        message: 'The upstream request timed out.',
        type: 'upstream_error',
        code: 'upstream_timeout',
      },
    })
  }
  if (error instanceof APIConnectionError) {
    return new UpstreamError(502, {
      error: {
        message: 'The upstream service could not be reached.',
        type: 'upstream_error',
        code: 'upstream_connection_error',
      },
    })
  }
  if (error instanceof APIError && error.status !== undefined) {
    const raw = error.error as Record<string, unknown> | undefined
    return new UpstreamError(error.status, {
      error: {
        message: typeof raw?.message === 'string' ? raw.message : error.message,
        type: typeof raw?.type === 'string' ? raw.type : (error.type ?? 'upstream_error'),
        code: typeof raw?.code === 'string' ? raw.code : (error.code ?? 'upstream_error'),
      },
    })
  }
  return new UpstreamError(502, {
    error: {
      message: 'The upstream service could not be reached.',
      type: 'upstream_error',
      code: 'upstream_connection_error',
    },
  })
}

function elapsed(started: number, finished: number): number {
  return Math.max(0, Math.round(finished - started))
}
