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
