/**
 * The Fastify application: the minimal HTTP surface the Stage 4 frontend needs, plus the WebSocket
 * attach point for a live session.
 *
 * Routes are thin — they resolve the acting user through the identity stub, call the orchestrator or
 * the recordings store, and map an {@link OrchestratorError} onto its HTTP status. The orchestrator
 * is the only thing that knows about sessions; this layer never touches the driver or the container.
 */
import { existsSync } from 'node:fs'

import fastifyStatic from '@fastify/static'
import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'

import type { EnvironmentRegistry } from './environments.js'
import { isAllowlisted, resolveUserId } from './identity.js'
import type { RecordingsStore } from './recordings.js'
import type { Retention } from './retention.js'
import type { ClientSocket } from './session/live-session.js'
import { type Orchestrator, OrchestratorError } from './session/orchestrator.js'

export interface AppDeps {
  orchestrator: Orchestrator
  environments: EnvironmentRegistry
  recordings: RecordingsStore
  /** The retention service: the merged recordings listing, pinning, and the eviction sweep. */
  retention: Retention
  /** The operator-configured session allowlist, so `/api/me` can report what the user may do. */
  allowlist: readonly string[]
  /**
   * The built frontend bundle to serve at the root. When present (a production launch), the backend
   * serves the SPA so the whole stack is one origin and one process. Omitted in dev (Vite serves it
   * and proxies `/api` here) and in tests; serving is wired only when the directory actually exists.
   */
  frontendDir?: string
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

  // The merged listing: each readable recording's header plus its retention metadata (owner, age,
  // pin state), optionally narrowed to one environment with `?env=`. Open to everyone (read-only).
  app.get<{ Querystring: { env?: string } }>('/api/recordings', (request) =>
    deps.retention.list({ env: request.query.env }),
  )

  app.get<{ Params: { id: string } }>('/api/recordings/:id', async (request, reply) => {
    if (!(await deps.recordings.exists(request.params.id))) {
      return reply.code(404).send({ error: 'no such recording' })
    }
    return reply.type('application/x-ndjson').send(deps.recordings.stream(request.params.id))
  })

  // Pin and unpin are owner-only and gate on the recording's retention row. Pinning is refused
  // with `pinned_quota` once the user is at their pinned cap, so the per-user quota stays a hard
  // bound on storage even though pinned recordings are exempt from eviction.
  app.post<{ Params: { id: string } }>('/api/recordings/:id/pin', (request, reply) =>
    replyPin(reply, deps.retention.pin(request.params.id, resolveUserId(request.headers))),
  )
  app.delete<{ Params: { id: string } }>('/api/recordings/:id/pin', (request, reply) =>
    replyPin(reply, deps.retention.unpin(request.params.id, resolveUserId(request.headers))),
  )

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

  // Serve the built frontend from the same origin in production so the whole stack is one process.
  // `wildcard: false` registers a route per built file and lets unmatched paths fall to the
  // not-found handler, which returns index.html for any non-API GET — the SPA fallback that makes a
  // hard refresh on a client route (/environments/:id, /sessions/:id, /replays/:id) load. Everything
  // under /api keeps its JSON 404. Wired only when the bundle exists, so dev and tests are untouched.
  if (deps.frontendDir !== undefined && existsSync(deps.frontendDir)) {
    await app.register(fastifyStatic, { root: deps.frontendDir, wildcard: false })
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.sendFile('index.html')
      }
      return reply.code(404).send({ error: 'not found' })
    })
  }

  return app
}

/** Map a {@link import('./retention.js').PinResult} onto its HTTP status, mirroring the typed codes. */
async function replyPin(
  reply: import('fastify').FastifyReply,
  result: Promise<import('./retention.js').PinResult>,
): Promise<unknown> {
  const outcome = await result
  if (outcome.ok) {
    return reply.code(204).send()
  }
  switch (outcome.reason) {
    case 'not_found':
      return reply.code(404).send({ error: 'no such recording' })
    case 'forbidden':
      return reply.code(403).send({ error: 'not your recording' })
    case 'pinned_quota':
      return reply.code(409).send({ error: 'pinned recording quota reached', code: 'pinned_quota' })
  }
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
