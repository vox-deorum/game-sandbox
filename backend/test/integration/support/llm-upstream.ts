import Fastify, { type FastifyInstance } from 'fastify'

/** One request observed by the deterministic local OpenAI-compatible test upstream. */
export interface StubUpstreamRequest {
  readonly arrivedAt: number
  readonly authorization: string | undefined
  readonly body: Record<string, unknown>
  readonly logicalRequestId: string | undefined
  readonly model: string | undefined
  readonly scenario: StubScenario
}

/** Behaviours selected by a `[stub:<scenario>[:<logical-id>]]` marker in a user message. */
export type StubScenario =
  | 'success'
  | 'retry-success'
  | 'non-retryable'
  | 'retry-exhausted'
  | 'missing-usage'
  | 'malformed-usage'
  | 'special-tokens'
  | 'provider-metadata'
  | 'delayed-success'

export interface LlmUpstreamStub {
  readonly app: FastifyInstance
  readonly requests: StubUpstreamRequest[]
  listen(): Promise<string>
  close(): Promise<void>
}

/** Total upstream attempts before the retry-success scenario returns a completion. */
export const RETRY_SUCCESS_ATTEMPTS = 3

const scenarios = new Set<StubScenario>([
  'success',
  'retry-success',
  'non-retryable',
  'retry-exhausted',
  'missing-usage',
  'malformed-usage',
  'special-tokens',
  'provider-metadata',
  'delayed-success',
])

/**
 * A local upstream shared by Docker integration and browser harnesses. It deliberately selects
 * behaviour from normal request content so the proxy sees the exact OpenAI-compatible payload it
 * would receive in production. The marker is not a side channel and is retained in recorded input.
 */
export function createLlmUpstreamStub(options: { delayMs?: number } = {}): LlmUpstreamStub {
  const app = Fastify({ logger: false })
  const requests: StubUpstreamRequest[] = []
  const retryAttempts = new Map<string, number>()
  const delayMs = options.delayMs ?? 150

  app.post('/v1/chat/completions', async (request, reply) => {
    const body = asObject(request.body)
    const selection = scenarioFor(body)
    const { scenario, logicalRequestId } = selection
    const entry: StubUpstreamRequest = {
      arrivedAt: Date.now(),
      authorization: request.headers.authorization,
      body,
      logicalRequestId,
      model: typeof body.model === 'string' ? body.model : undefined,
      scenario,
    }
    requests.push(entry)
    if (scenario === 'retry-success' && logicalRequestId === undefined) {
      return reply.code(400).send({
        error: {
          message: 'retry-success requires a logical request id in the stub marker',
          type: 'stub_error',
          code: 'stub_missing_logical_request_id',
        },
      })
    }
    const retryKey = `${scenario}:${logicalRequestId ?? 'not-retried'}`
    const attempts = (retryAttempts.get(retryKey) ?? 0) + 1
    retryAttempts.set(retryKey, attempts)

    if (scenario === 'non-retryable') {
      return reply.code(400).send(errorBody(400))
    }
    if (scenario === 'retry-exhausted') {
      return reply.code(503).send(errorBody(503))
    }
    if (scenario === 'retry-success' && attempts < RETRY_SUCCESS_ATTEMPTS) {
      return reply.code(attempts === 1 ? 429 : 500).send(errorBody(attempts === 1 ? 429 : 500))
    }
    if (scenario === 'delayed-success') {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
    }

    const completion = successfulCompletion(requests.length, scenario)
    retryAttempts.delete(retryKey)
    return reply.send(completion)
  })
  return {
    app,
    requests,
    listen: () => app.listen({ port: 0, host: '127.0.0.1' }),
    close: () => app.close(),
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function scenarioFor(body: Record<string, unknown>): {
  scenario: StubScenario
  logicalRequestId: string | undefined
} {
  const messages = body.messages
  if (!Array.isArray(messages)) return { scenario: 'success', logicalRequestId: undefined }
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const content = (message as Record<string, unknown>).content
    if (typeof content !== 'string') continue
    const matched = /^\[stub:([a-z-]+)(?::([A-Za-z0-9._-]+))?\]/.exec(content)
    if (matched !== null && scenarios.has(matched[1] as StubScenario)) {
      return { scenario: matched[1] as StubScenario, logicalRequestId: matched[2] }
    }
  }
  return { scenario: 'success', logicalRequestId: undefined }
}

function errorBody(status: number): Record<string, unknown> {
  return {
    error: { message: `stub upstream ${status}`, type: 'stub_error', code: `stub_${status}` },
  }
}

function successfulCompletion(index: number, scenario: StubScenario): Record<string, unknown> {
  const completion: Record<string, unknown> = {
    id: `stub-completion-${index}`,
    object: 'chat.completion',
    created: index,
    model: 'provider-small',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content:
            scenario === 'special-tokens'
              ? '<|endoftext|> ordinary completion content <|fim_prefix|>'
              : 'Play the lowest legal card.',
        },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  }
  if (scenario === 'missing-usage') delete completion.usage
  if (scenario === 'malformed-usage') completion.usage = { prompt_tokens: 'not-a-number' }
  if (scenario === 'provider-metadata') {
    completion.provider = { routed_model: 'private-provider-small', trace_id: 'private-trace' }
  }
  return completion
}
