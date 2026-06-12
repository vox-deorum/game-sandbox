/**
 * The Fastify application: the minimal HTTP surface the Stage 4 frontend needs, plus the WebSocket
 * attach point for a live session.
 *
 * Routes are thin — they resolve the acting user through the identity stub, call the orchestrator or
 * the recordings store, and map an {@link OrchestratorError} onto its HTTP status. The orchestrator
 * is the only thing that knows about sessions; this layer never touches the driver or the container.
 */
import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'

import type { EnvironmentRegistry } from './environments.js'
import { isAllowlisted, resolveUserId } from './identity.js'
import type { RecordingsStore } from './recordings.js'
import type { ClientSocket } from './session/live-session.js'
import { type Orchestrator, OrchestratorError } from './session/orchestrator.js'

export interface AppDeps {
  orchestrator: Orchestrator
  environments: EnvironmentRegistry
  recordings: RecordingsStore
  /** The operator-configured session allowlist, so `/api/me` can report what the user may do. */
  allowlist: readonly string[]
}

/** JSON-schema body for POST /api/sessions; Fastify 400s on a violation before the handler runs. */
const START_SESSION_SCHEMA = {
  body: {
    type: 'object',
    required: ['env_id', 'mode'],
    additionalProperties: false,
    properties: {
      env_id: { type: 'string', minLength: 1 },
      mode: { type: 'string', enum: ['human', 'scripted'] },
      seed: { type: 'integer', minimum: 0 },
      human_slot_timeout_ms: { type: 'integer', minimum: 0 },
    },
  },
} as const

interface StartBody {
  env_id: string
  mode: 'human' | 'scripted'
  seed?: number
  human_slot_timeout_ms?: number
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(websocket)

  app.get('/api/environments', () => deps.environments.list())

  // The frontend's single source for who-am-I and what-may-I-do. One mock user is auto-logged-on
  // by the browser; this reports the resolved id and allowlist membership so the OAuth replacement
  // has one obvious place to land.
  app.get('/api/me', (request) => {
    const userId = resolveUserId(request.headers)
    return { user_id: userId, allowlisted: isAllowlisted(userId, deps.allowlist) }
  })

  app.post<{ Body: StartBody }>(
    '/api/sessions',
    { schema: START_SESSION_SCHEMA },
    async (request, reply) => {
      try {
        const result = await deps.orchestrator.start({
          userId: resolveUserId(request.headers),
          envId: request.body.env_id,
          mode: request.body.mode,
          seed: request.body.seed,
          humanSlotTimeoutMs: request.body.human_slot_timeout_ms,
        })
        return reply.code(201).send({ id: result.id, ws_path: result.wsPath })
      } catch (error) {
        return replyError(reply, error)
      }
    },
  )

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    const session = await deps.orchestrator.getSession(request.params.id)
    if (session === undefined) {
      return reply.code(404).send({ error: 'no such session' })
    }
    return session
  })

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    try {
      await deps.orchestrator.stop(request.params.id, resolveUserId(request.headers))
      return reply.code(204).send()
    } catch (error) {
      return replyError(reply, error)
    }
  })

  app.get('/api/recordings', () => deps.recordings.list())

  app.get<{ Params: { id: string } }>('/api/recordings/:id', async (request, reply) => {
    if (!(await deps.recordings.exists(request.params.id))) {
      return reply.code(404).send({ error: 'no such recording' })
    }
    return reply.type('application/x-ndjson').send(deps.recordings.stream(request.params.id))
  })

  app.get<{ Params: { id: string } }>(
    '/api/sessions/:id/ws',
    { websocket: true },
    (socket, request) => {
      // A browser cannot set a header on a WebSocket upgrade, so the socket client carries the
      // identity as the `user` query parameter; resolveUserId reads it when the header is absent.
      const userId = resolveUserId(request.headers, request.query as Record<string, string>)
      const client: ClientSocket = {
        send: (data) => socket.send(data),
        close: () => socket.close(),
        get bufferedAmount() {
          return socket.bufferedAmount
        },
      }
      const attachment = deps.orchestrator.attach(request.params.id, client, userId)
      if (attachment === undefined) {
        socket.close(1008, 'no such session')
        return
      }
      socket.on('message', (data: Buffer) => attachment.handleMessage(data.toString()))
      socket.on('close', () => attachment.detach())
    },
  )

  return app
}

function replyError(reply: import('fastify').FastifyReply, error: unknown): unknown {
  if (error instanceof OrchestratorError) {
    // The body carries a stable `code` the frontend branches on, plus any details (the active
    // session id) merged in so the 409 rejoin path has somewhere to read it.
    return reply
      .code(error.status)
      .send({ error: error.message, code: error.code, ...error.details })
  }
  throw error
}
