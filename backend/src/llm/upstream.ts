import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai'

import { LlmError, type LlmErrorBody } from './errors.js'
import type { LlmChatCompletion, LlmChatRequest } from './types.js'

export interface UpstreamChatClient {
  create(
    request: LlmChatRequest,
    options: { timeout: number; maxRetries: 0; signal?: AbortSignal },
  ): Promise<LlmChatCompletion>
}

export interface UpstreamCallerOptions {
  baseURL: string
  apiKey?: string
  timeoutMs: number
  maxRetries: number
  retryIntervalMs: number
  client?: UpstreamChatClient
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
}

export interface UpstreamSuccess {
  completion: LlmChatCompletion
  latencyMs: number
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

/** One explicit retry loop around an SDK client whose own retries are disabled. */
export class UpstreamCaller {
  private readonly client: UpstreamChatClient
  private readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>
  private readonly now: () => number

  constructor(private readonly options: UpstreamCallerOptions) {
    if (options.client !== undefined) {
      this.client = options.client
    } else {
      const sdk = new OpenAI({
        apiKey: options.apiKey ?? 'unused-no-upstream-credential',
        baseURL: options.baseURL,
        maxRetries: 0,
        // Some OpenAI-compatible local endpoints are deliberately unauthenticated. The SDK requires
        // an apiKey constructor value, then this explicit null suppresses its generated bearer header.
        ...(options.apiKey === undefined ? { defaultHeaders: { Authorization: null } } : {}),
      })
      this.client = {
        create: (request, requestOptions) =>
          sdk.chat.completions.create(request, requestOptions) as Promise<LlmChatCompletion>,
      }
    }
    this.sleep = options.sleep ?? abortableSleep
    this.now = options.now ?? Date.now
  }

  async call(request: LlmChatRequest, signal?: AbortSignal): Promise<UpstreamSuccess> {
    const started = this.now()
    let finalError: unknown
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      signal?.throwIfAborted()
      try {
        const completion = await this.client.create(request, {
          timeout: this.options.timeoutMs,
          maxRetries: 0,
          ...(signal === undefined ? {} : { signal }),
        })
        return { completion, latencyMs: elapsed(started, this.now()) }
      } catch (error) {
        finalError = error
        if (!retryable(error) || attempt === this.options.maxRetries) break
        const retryNumber = attempt + 1
        await this.sleep(this.options.retryIntervalMs * 2 ** (retryNumber - 1), signal)
      }
    }
    throw normalizeUpstreamError(finalError)
  }
}

/** Default retry sleep that revocation can interrupt without waiting for the next attempt. */
function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(resolve, delayMs)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

function retryable(error: unknown): boolean {
  if (error instanceof APIConnectionError || error instanceof APIConnectionTimeoutError) return true
  if (!(error instanceof APIError) || error.status === undefined) return false
  return [408, 409, 429].includes(error.status) || error.status >= 500
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
