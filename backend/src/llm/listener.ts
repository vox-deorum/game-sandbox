import Fastify, { type FastifyInstance } from 'fastify'

import { asLlmError, invalidRequest, LlmError, readBearer } from './errors.js'
import type { LlmHandler } from './handler.js'
import type { KeyRegistry } from './key-registry.js'

export interface LlmListenerDeps {
  registry: KeyRegistry
  handler: LlmHandler
  log?: (message: string) => void
}

/** Build the backend-internal OpenAI-compatible listener without binding a port. */
export async function buildLlmListener(deps: LlmListenerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  app.post('/v1/chat/completions', async (request, reply) => {
    let releaseAdmission: (() => void) | undefined
    try {
      const admission = deps.registry.authenticateRequest(readBearer(request.headers.authorization))
      releaseAdmission = admission.release
      return await deps.handler.handle(admission.grant, request.body, {
        signal: admission.signal,
        beginFinalization: admission.beginFinalization,
      })
    } catch (error) {
      const normalized = asLlmError(error)
      return reply.code(normalized.status).send(normalized.body())
    } finally {
      releaseAdmission?.()
    }
  })

  app.post('/internal/tick', async (request, reply) => {
    try {
      const entry = deps.registry.authenticateOfficial(readBearer(request.headers.authorization))
      entry.tick.current = parseTick(request.body)
      return { ok: true }
    } catch (error) {
      const normalized = asLlmError(error)
      return reply.code(normalized.status).send(normalized.body())
    }
  })

  app.post('/internal/inflight', async (request, reply) => {
    try {
      const entry = deps.registry.authenticateOfficial(readBearer(request.headers.authorization))
      return { inflight_ms: deps.registry.inFlightMsForScope(entry.grant.accountingScope.key) }
    } catch (error) {
      const normalized = asLlmError(error)
      return reply.code(normalized.status).send(normalized.body())
    }
  })

  // Fastify owns JSON parsing. Normalize its malformed-JSON response to the same pinned envelope.
  app.setErrorHandler((error, _request, reply) => {
    deps.log?.('LLM listener rejected malformed request')
    const normalized =
      error instanceof LlmError
        ? error
        : invalidRequest('invalid_request', 'The request body is not valid JSON.')
    void reply.code(normalized.status).send(normalized.body())
  })
  app.setNotFoundHandler((_request, reply) => {
    const error = new LlmError(404, 'not_found', 'The requested LLM route was not found.')
    void reply.code(error.status).send(error.body())
  })
  await app.ready()
  return app
}

function parseTick(body: unknown): number | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidRequest('invalid_tick_marker', 'The tick marker must be a JSON object.')
  }
  const value = body as Record<string, unknown>
  const keys = Object.keys(value)
  if (keys.length === 1 && value.phase === 'setup') return null
  if (
    keys.length === 1 &&
    typeof value.tick === 'number' &&
    Number.isSafeInteger(value.tick) &&
    value.tick >= 0
  ) {
    return value.tick
  }
  throw invalidRequest(
    'invalid_tick_marker',
    'Use {"phase":"setup"} or a non-negative integer tick.',
  )
}
