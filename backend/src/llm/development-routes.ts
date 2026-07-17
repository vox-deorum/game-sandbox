import type { FastifyInstance } from 'fastify'

import type { RequestIdentity } from '../identity.js'
import type { DevelopmentKeyService } from './development-keys.js'
import { asLlmError, readBearer } from './errors.js'
import type { LlmHandler } from './handler.js'

export interface DevelopmentLlmRouteDeps {
  identity: RequestIdentity
  keys: DevelopmentKeyService
  handler: LlmHandler
}

/** Mount key rotation and the public OpenAI-compatible development completion route. */
export function registerDevelopmentLlmRoutes(
  app: FastifyInstance,
  deps: DevelopmentLlmRouteDeps,
): void {
  app.post<{ Params: { seasonId: string } }>(
    '/api/seasons/:seasonId/llm-development-key',
    async (request, reply) => {
      const user = await deps.identity.requireActive(request, reply)
      if (user === undefined) return
      try {
        return await deps.keys.rotate(request.params.seasonId, user.id)
      } catch (error) {
        const normalized = asLlmError(error)
        return reply.code(normalized.status).send(normalized.body())
      }
    },
  )

  app.post('/api/llm/v1/chat/completions', async (request, reply) => {
    try {
      const grant = await deps.keys.authenticate(readBearer(request.headers.authorization))
      return await deps.handler.handle(grant, request.body)
    } catch (error) {
      const normalized = asLlmError(error)
      return reply.code(normalized.status).send(normalized.body())
    }
  })
}
