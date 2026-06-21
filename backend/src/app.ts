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

import { registerAdminRoutes } from './admin/routes.js'
import type { EnvironmentRegistry } from './environments.js'
import { isAllowlisted, isOperator, resolveUserId } from './identity.js'
import { registerLeaderboardRoutes } from './leaderboards/routes.js'
import { registerRatingRoutes } from './ratings/routes.js'
import type { RecordingsStore } from './recordings.js'
import type { Retention } from './retention.js'
import type { ClientSocket } from './session/live-session.js'
import { type Orchestrator, OrchestratorError } from './session/orchestrator.js'
import { type Storage, SubmissionConflictError, type SubmissionStatus } from './storage/index.js'
import type { SourceInput, SubmissionSource } from './submission/source/index.js'
import type { SubmissionEnqueuer } from './submission/worker.js'
import type { WorkflowRunner } from './workflow/runner.js'

export interface AppDeps {
  orchestrator: Orchestrator
  environments: EnvironmentRegistry
  recordings: RecordingsStore
  /** The retention service: the merged recordings listing, pinning, and the eviction sweep. */
  retention: Retention
  /** The operator-configured session allowlist, so `/api/me` can report what the user may do. */
  allowlist: readonly string[]
  /** The operator allowlist gating the Stage 6 admin API; the `isOperator` predicate consults it. */
  operatorAllowlist: readonly string[]
  /** Dependency-set versions backed by concrete base-image definitions on this deployment. */
  knownDepsVersions: ReadonlySet<number>
  /** The background workflow execution seam the admin trigger enqueues onto and the log stream relays. */
  workflowRunner: WorkflowRunner
  /** The storage seam, for the submission create/read/list routes (Stage 5.5). */
  storage: Storage
  /** The submission-source seam, for the reachability pre-check (Stage 5.2/5.5). */
  submissionSource: SubmissionSource
  /** The bounded validation worker the submit route enqueues onto; the pipeline runs out of band. */
  validationWorker: SubmissionEnqueuer
  /** Whether the dev-only local-folder source is offered; drives capabilities and the local gate. */
  allowLocalSubmissions: boolean
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
      // When present, run this submitted agent in the slot (a watch run); the orchestrator validates
      // it is `ready` and active for the play-open season. Identity still rides the header.
      submission_id: { type: 'string', minLength: 1 },
    },
  },
} as const

interface StartBody {
  env_id: string
  mode: 'human' | 'scripted'
  seed?: number
  human_slot_timeout_ms?: number
  submission_id?: string
}

/** The source fields shared by the reachability pre-check and the submit body. */
const SOURCE_PROPERTIES = {
  repo_url: { type: 'string' },
  ref: { type: ['string', 'null'] },
  local_path: { type: 'string' },
} as const

/** JSON-schema body for POST /api/submissions/reachability. */
const REACHABILITY_SCHEMA = {
  body: { type: 'object', additionalProperties: false, properties: SOURCE_PROPERTIES },
} as const

/** JSON-schema body for POST /api/submissions; the source is validated in the handler. */
const SUBMIT_SCHEMA = {
  body: {
    type: 'object',
    required: ['env_id'],
    additionalProperties: false,
    properties: { env_id: { type: 'string', minLength: 1 }, ...SOURCE_PROPERTIES },
  },
} as const

/** A participant's source as it arrives on the wire: a git repo (+ optional ref) or a local folder. */
interface SourceBody {
  repo_url?: string
  ref?: string | null
  local_path?: string
}

interface SubmitBody extends SourceBody {
  env_id: string
}

/** How many recent recordings the agent profile lists per submission; older runs stay queryable. */
const PROFILE_REPLAY_LIMIT = 10

/**
 * Map a wire source body onto the seam's {@link SourceInput}: a non-empty `local_path` is a local
 * source, otherwise a non-empty `repo_url` is a git source, otherwise null (neither was supplied).
 */
function sourceInputFromBody(body: SourceBody): SourceInput | null {
  if (typeof body.local_path === 'string' && body.local_path !== '') {
    return { kind: 'local', localPath: body.local_path }
  }
  if (typeof body.repo_url === 'string' && body.repo_url !== '') {
    return { kind: 'git', repoUrl: body.repo_url, ref: body.ref ?? null }
  }
  return null
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(websocket)

  app.get('/api/environments', () => deps.environments.list())

  // The frontend's single source for who-am-I and what-may-I-do. One mock user is auto-logged-on
  // by the browser; this reports the resolved id, session-allowlist membership, and operator status
  // (the Stage 6 admin console gates its route and nav entry on the last). The backend admin guard is
  // the real authority; `is_operator` only lets the UI avoid showing dead controls. The OAuth
  // replacement has one obvious place to land.
  app.get('/api/me', (request) => {
    const userId = resolveUserId(request.headers)
    return {
      user_id: userId,
      allowlisted: isAllowlisted(userId, deps.allowlist),
      is_operator: isOperator(userId, deps.operatorAllowlist),
    }
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
          submissionId: request.body.submission_id,
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

  // --- Submissions (Stage 5.5) ---------------------------------------------------------------
  // The capabilities probe: the form mirrors the backend's dev gate so the local-folder field is
  // driven by both `import.meta.env.DEV` and this flag, never by the frontend build alone.
  app.get('/api/submissions/capabilities', () => ({
    local_submissions: deps.allowLocalSubmissions,
  }))

  // The cheap pre-accept reachability check: verify the repo (and ref) before a row is written, the
  // explicit frontend requirement. A local source is refused here when the dev gate is off, before
  // the source seam is touched, matching step 2's gating.
  app.post<{ Body: SourceBody }>(
    '/api/submissions/reachability',
    { schema: REACHABILITY_SCHEMA },
    async (request, reply) => {
      const input = sourceInputFromBody(request.body)
      if (input === null) {
        return reply
          .code(400)
          .send({ error: 'a repo_url or local_path is required', code: 'invalid_source' })
      }
      if (input.kind === 'local' && !deps.allowLocalSubmissions) {
        return reply
          .code(403)
          .send({ error: 'local submissions are disabled', code: 'local_disabled' })
      }
      return reply.code(200).send(await deps.submissionSource.verifyReachable(input))
    },
  )

  // Submit: resolve the open season, create the pending row under the resolved identity, enqueue
  // the validate-and-build job, and return 202 — the pipeline never runs inline. The submitter is
  // never read from the client. Resubmission supersedes the prior active row inside createSubmission.
  app.post<{ Body: SubmitBody }>(
    '/api/submissions',
    { schema: SUBMIT_SCHEMA },
    async (request, reply) => {
      const input = sourceInputFromBody(request.body)
      if (input === null) {
        return reply
          .code(400)
          .send({ error: 'a repo_url or local_path is required', code: 'invalid_source' })
      }
      if (input.kind === 'local' && !deps.allowLocalSubmissions) {
        return reply
          .code(403)
          .send({ error: 'local submissions are disabled', code: 'local_disabled' })
      }
      const season = await deps.storage.getOpenSubmissionSeason(request.body.env_id)
      if (season === undefined) {
        return reply
          .code(409)
          .send({ error: 'submissions are closed for this environment', code: 'no_open_season' })
      }
      try {
        const submission = await deps.storage.createSubmission({
          season_id: season.id,
          env_id: request.body.env_id,
          user_id: resolveUserId(request.headers),
          source_kind: input.kind,
          repo_url: input.kind === 'git' ? input.repoUrl : null,
          commit_sha: null,
          local_path: input.kind === 'local' ? input.localPath : null,
          ref: input.kind === 'git' ? input.ref : null,
          created_at: new Date().toISOString(),
        })
        deps.validationWorker.enqueue(submission.id)
        return reply.code(202).send({ id: submission.id, status: submission.status })
      } catch (error) {
        if (error instanceof SubmissionConflictError) {
          // A concurrent resubmit won the active slot; the client may retry.
          return reply.code(409).send({ error: error.message, code: 'resubmit_conflict' })
        }
        throw error
      }
    },
  )

  // The current user's submissions (including superseded history), newest first, optionally one
  // environment. The agent profile (step 6) reads this; the form reads the single submission below.
  app.get<{ Querystring: { env?: string } }>('/api/submissions', (request) =>
    deps.storage.listSubmissionsByUser(resolveUserId(request.headers), request.query.env),
  )

  // One submission joined with its ordered per-stage validation log, so a poll is a single request.
  app.get<{ Params: { id: string } }>('/api/submissions/:id', async (request, reply) => {
    const submission = await deps.storage.getSubmission(request.params.id)
    if (submission === undefined) {
      return reply.code(404).send({ error: 'no such submission' })
    }
    const checks = await deps.storage.listSubmissionChecks(submission.id)
    return { ...submission, checks }
  })

  // Active submissions for an environment's play-open season, optionally narrowed by status. The
  // submission window may point at a different round, so it must not drive public watch choices.
  app.get<{ Params: { envId: string }; Querystring: { status?: string } }>(
    '/api/environments/:envId/submissions',
    async (request) => {
      const season = await deps.storage.getPublicPlaySeason(request.params.envId)
      if (season === undefined) {
        return []
      }
      return deps.storage.listActiveSubmissionsBySeason(
        season.id,
        request.query.status as SubmissionStatus | undefined,
      )
    },
  )

  // The agent profile (step 6): one owner's submission history for an environment, with every commit they
  // submitted across seasons (including superseded rows), each joined with its per-stage validation
  // log and its recent watch/replay recording ids. Keyed by environment id and owner id so a future
  // Hearts agent stays separate from the same user's Flappy Bird agent. Open (read-only); owner-only
  // affordances (the Stage 9 debug view) gate on the client comparing this owner_id to its identity.
  app.get<{ Params: { envId: string; ownerId: string } }>(
    '/api/environments/:envId/agents/:ownerId',
    async (request) => {
      const [submissions, submissionTarget, playTarget] = await Promise.all([
        deps.storage.listSubmissionsByUser(request.params.ownerId, request.params.envId),
        deps.storage.getOpenSubmissionSeason(request.params.envId),
        deps.storage.getPublicPlaySeason(request.params.envId),
      ])
      const detailed = await Promise.all(
        submissions.map(async (submission) => ({
          ...submission,
          checks: await deps.storage.listSubmissionChecks(submission.id),
          replays: await deps.storage.listRecordingsBySubmission(
            submission.id,
            PROFILE_REPLAY_LIMIT,
          ),
        })),
      )
      return {
        env_id: request.params.envId,
        owner_id: request.params.ownerId,
        submission_season_id: submissionTarget?.id ?? null,
        play_season_id: playTarget?.id ?? null,
        submissions: detailed,
      }
    },
  )

  // --- Leaderboards: operator admin API and public reads (Stage 6.3) ------------------------
  // The admin routes are an encapsulated, operator-gated plugin under `/api/admin`; the public
  // board/history reads are ungated and serve only released results. Registered before the SPA
  // fallback below so the catch-all never shadows them.
  await registerAdminRoutes(app, {
    storage: deps.storage,
    environments: deps.environments,
    workflowRunner: deps.workflowRunner,
    operatorAllowlist: deps.operatorAllowlist,
    knownDepsVersions: deps.knownDepsVersions,
  })
  registerLeaderboardRoutes(app, {
    storage: deps.storage,
    operatorAllowlist: deps.operatorAllowlist,
  })
  // Participant ratings and the author's per-season rating prompt are attributed to the resolved
  // identity. Rating writes also use the public-session allowlist.
  registerRatingRoutes(app, {
    storage: deps.storage,
    recordings: deps.recordings,
    allowlist: deps.allowlist,
  })

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
