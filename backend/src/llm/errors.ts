export interface LlmErrorBody {
  error: {
    message: string
    type: string
    code: string
  }
}

/** A terminal response already normalized to the proxy's OpenAI-compatible shape. */
export class LlmError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly type = 'invalid_request_error',
  ) {
    super(message)
    this.name = 'LlmError'
  }

  body(): LlmErrorBody {
    return { error: { message: this.message, type: this.type, code: this.code } }
  }
}

export function invalidRequest(code: string, message: string): LlmError {
  return new LlmError(400, code, message)
}

export function asLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error
  return new LlmError(
    500,
    'internal_error',
    'The LLM proxy encountered an internal error.',
    'server_error',
  )
}

/** Parse a request's bearer credential, shared by every key-authenticated LLM route. */
export function readBearer(header: string | undefined): string {
  const match = /^Bearer ([^\s]+)$/i.exec(header ?? '')
  if (match?.[1] === undefined) {
    throw new LlmError(401, 'invalid_api_key', 'A valid bearer API key is required.')
  }
  return match[1]
}
