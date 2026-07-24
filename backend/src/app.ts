/**
 * The Fastify application: the minimal HTTP surface the Stage 4 frontend needs, plus the WebSocket
 * attach point for a live session.
 *
 * Routes are thin — they resolve the acting user through the identity seam (a Better Auth session
 * cookie), call the orchestrator or the recordings store, and map an {@link OrchestratorError} onto
 * its HTTP status. The orchestrator is the only thing that knows about sessions; this layer never
 * touches the driver or the container.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import fastifyStatic from '@fastify/static'
import websocket from '@fastify/websocket'
import type { RecordingHeader } from '@game-sandbox/schema'
import { type ParameterValue, resolveParameters } from '@game-sandbox/schema/environment'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'

import { registerAdminRoutes } from './admin/routes.js'
import type { Auth } from './auth/auth.js'
import { registerAuthRoutes } from './auth/routes.js'
import type { UserDirectory } from './auth/users.js'
import type { LlmOptions } from './config.js'
import { buildDocsManifest, DocsIndexError, readDocsIndex, readDocsPage } from './docs.js'
import { REPO_ROOT } from './env-files.js'
import type { EnvironmentRegistry } from './environments.js'
import { createRequestIdentity } from './identity.js'
import { registerLeaderboardRoutes } from './leaderboards/routes.js'
import type { DevelopmentKeyService } from './llm/development-keys.js'
import { registerDevelopmentLlmRoutes } from './llm/development-routes.js'
import type { LlmHandler } from './llm/handler.js'
import { registerRecordingLlmRoutes } from './llm/recording-routes.js'
import { registerMyAgentRoutes } from './my-agents.js'
import { optionalField } from './optional-field.js'
import { registerRatingRoutes } from './ratings/routes.js'
import type { RecordingsStore } from './recordings.js'
import { isBlindRecording, maskPlayers, replaceHeaderLine } from './recordings-view.js'
import type { Retention } from './retention.js'
import type { ClientSocket } from './session/live-session.js'
import {
  type Orchestrator,
  OrchestratorError,
  type SlotAssignment,
} from './session/orchestrator.js'
import { decodeSeasonConfig, type Storage, SubmissionConflictError } from './storage/index.js'
import type { DevelopmentLedgerStore } from './storage/llm/development-ledger/store.js'
import type { ExecutionTelemetryStore } from './storage/llm/execution-telemetry.js'
import type { SubmissionSnapshotStore } from './submission/snapshot-store.js'
import type { SourceInput, SubmissionSource } from './submission/source/index.js'
import type { SubmissionEnqueuer } from './submission/worker.js'
import type { WorkflowRunner } from './workflow/runner.js'

// Isolated buildApp tests may omit deployment wiring. Runtime startup always passes the validated
// values loaded through Config; these fallbacks mirror `.env.default` for app-only callers.
const DEFAULT_SITE_NAME = 'Game Sandbox'
const DEFAULT_DOCS_DIR = join(REPO_ROOT, 'docs')
const DEFAULT_ENVIRONMENTS_DIR = join(REPO_ROOT, 'environments')

export interface AppDeps {
  orchestrator: Orchestrator
  /**
   * The deployment's display name, served to the SPA by `GET /api/config` so the sidebar brand and the
   * document title reflect the operator's `SITE_NAME`. Optional here: tests and any caller that omits it
   * fall back to {@link DEFAULT_SITE_NAME}, the same default `loadConfig` applies.
   */
  siteName?: string
  /**
   * The compact brand for space-sensitive chrome, also served by `GET /api/config`. Falls back to
   * {@link AppDeps.siteName} (then {@link DEFAULT_SITE_NAME}) when omitted, mirroring `loadConfig`.
   */
  siteShortName?: string
  /**
   * Whether this deployment configured GitHub OAuth, served to the SPA by `GET /api/config` so the
   * login page shows or hides the "Sign in with GitHub" button. `main.ts` derives it from whether
   * `config.auth.github` is set; defaults to `false` when omitted (email-and-password sign-in only).
   */
  githubAuth?: boolean
  environments: EnvironmentRegistry
  recordings: RecordingsStore
  /** The retention service: the merged recordings listing, pinning, and the eviction sweep. */
  retention: Retention
  /** Dependency-set versions backed by concrete base-image definitions on this deployment. */
  knownDepsVersions: ReadonlySet<number>
  /** The background workflow execution seam the admin trigger enqueues onto and the log stream relays. */
  workflowRunner: WorkflowRunner
  /** The storage seam, for the submission create/read/list routes (Stage 5.5). */
  storage: Storage
  /** The submission-source seam, for the reachability pre-check (Stage 5.2/5.5). */
  submissionSource: SubmissionSource
  /** The submission-snapshot store, for the operator download routes (individual + whole-season). */
  submissionSnapshots: SubmissionSnapshotStore
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
  /**
   * The documentation root the docs routes read shared student guides from (its `students/`
   * subtree). The server passes `config.docsDir` and tests pass a fixture directory; when omitted
   * the routes fall back to {@link DEFAULT_DOCS_DIR} (the repo's `docs/`), so a caller that does not
   * exercise the docs area can leave it unset.
   */
  docsDir?: string
  /**
   * The package root containing canonical `environment.md` guides. Runtime uses the repository's
   * `environments/` directory; tests may point this at an isolated fixture.
   */
  environmentGuidesDir?: string
  /** Optional class-index override: when set, `GET /api/docs/index` serves this file's markdown. */
  docsIndexFile?: string
  /**
   * The Better Auth instance mounted at `/api/auth/*` and consumed by the identity seam (Stage 12.2).
   * Required: every request resolves its acting user by looking up the session cookie against this
   * instance, and every suite mints real sessions through the harness.
   */
  auth: Auth
  /**
   * The display-name directory (Stage 12.4): routes batch the Better Auth user ids they are about to
   * return through it and attach a readable name beside each stable id. Read-only; enrichment happens
   * only at the response boundary, never in stored rows.
   */
  userDirectory: UserDirectory
  /** Current deployment LLM configuration, used by admin season validation and run-policy freezing. */
  llm: LlmOptions
  /** Public development-key and history routes; the handler is absent without upstream calling. */
  llmDevelopment?: {
    keys: DevelopmentKeyService
    handler?: LlmHandler
    ledger: DevelopmentLedgerStore
  }
  /** Retained official telemetry reader; associated recordings fail closed when it is unavailable. */
  officialTelemetry?: Pick<ExecutionTelemetryStore, 'readAssociatedCalls'>
}

/**
 * JSON-schema body for POST /api/sessions; Fastify 400s before the handler runs. The body is an
 * explicit per-slot `slots` assignment keyed by slot id; each value names what fills the slot (human,
 * built-in Naive, or a named submission), with `submission_id` required exactly for a `submission`
 * slot. The orchestrator derives the mode and validates the composition. The old top-level `mode`/
 * `submission_id` shape is rejected: `slots` is required and those fields are not permitted here.
 */
const START_SESSION_SCHEMA = {
  body: {
    type: 'object',
    required: ['env_id', 'season_id', 'parameters', 'slots'],
    additionalProperties: false,
    properties: {
      env_id: { type: 'string', minLength: 1 },
      season_id: { type: 'string', minLength: 1 },
      seed: { type: 'integer', minimum: 0 },
      human_slot_timeout_ms: { type: 'integer', minimum: 0 },
      parameters: {
        type: 'object',
        additionalProperties: {
          type: ['boolean', 'number', 'string', 'array'],
          items: { type: 'string' },
        },
      },
      slots: {
        type: 'object',
        minProperties: 1,
        propertyNames: { pattern: '^player_[0-9]+$' },
        additionalProperties: {
          type: 'object',
          required: ['kind'],
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['human', 'builtin-agent', 'submission'] },
            submission_id: { type: 'string', minLength: 1 },
          },
          // `submission_id` is present exactly for a `submission` slot — required there, forbidden
          // elsewhere — so the orchestrator's discriminated union is honest at the trust boundary.
          oneOf: [
            {
              properties: { kind: { enum: ['human', 'builtin-agent'] } },
              not: { required: ['submission_id'] },
            },
            { properties: { kind: { const: 'submission' } }, required: ['submission_id'] },
          ],
        },
      },
    },
  },
} as const

/** One slot's assignment on the wire: snake-case `submission_id`, mapped to the orchestrator shape. */
interface SlotAssignmentBody {
  kind: 'human' | 'builtin-agent' | 'submission'
  submission_id?: string
}

interface StartBody {
  env_id: string
  season_id: string
  seed?: number
  human_slot_timeout_ms?: number
  parameters: Record<string, ParameterValue>
  slots: Record<string, SlotAssignmentBody>
}

/**
 * Map a wire slot assignment onto the orchestrator's discriminated union. The schema has already
 * guaranteed `submission_id` is present exactly for a `submission` slot, so the boundary cast is safe.
 */
function toSlotAssignment(body: SlotAssignmentBody): SlotAssignment {
  if (body.kind === 'submission') {
    return { kind: 'submission', submissionId: body.submission_id as string }
  }
  return { kind: body.kind }
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

/**
 * Apply the submission-source admission policy shared by reachability and submit. Local paths keep
 * precedence over repo URLs, and the local-development gate is checked before either route performs
 * any source or season work. Returns `undefined` after sending the existing typed refusal.
 */
function admitSubmissionSource(
  body: SourceBody,
  allowLocalSubmissions: boolean,
  reply: FastifyReply,
): SourceInput | undefined {
  const input = sourceInputFromBody(body)
  if (input === null) {
    reply.code(400).send({ error: 'a repo_url or local_path is required', code: 'invalid_source' })
    return undefined
  }
  if (input.kind === 'local' && !allowLocalSubmissions) {
    reply.code(403).send({ error: 'local submissions are disabled', code: 'local_disabled' })
    return undefined
  }
  return input
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, ajv: { customOptions: { strictTypes: false } } })
  await app.register(websocket)

  // The one place a request is turned into an acting user: a Better Auth session-cookie lookup,
  // memoized per request, with the three status guards routes gate on. Public routes never call it.
  const identity = createRequestIdentity(deps.auth)

  if (deps.llmDevelopment !== undefined) {
    registerDevelopmentLlmRoutes(app, { identity, storage: deps.storage, ...deps.llmDevelopment })
  }
  registerRecordingLlmRoutes(app, {
    identity,
    recordings: deps.recordings,
    storage: deps.storage,
    ...(deps.officialTelemetry === undefined ? {} : { telemetry: deps.officialTelemetry }),
  })

  app.get('/api/environments', () => deps.environments.list())

  app.get<{ Params: { envId: string } }>(
    '/api/environments/:envId/play-parameters',
    async (request, reply) => {
      const meta = deps.environments.get(request.params.envId)
      if (meta === undefined) {
        return reply.code(404).send({ error: 'no such environment' })
      }
      const season = await deps.storage.getPublicPlaySeason(meta.env_id)
      const resolved = resolveParameters(
        meta.parameters,
        season === undefined ? {} : (decodeSeasonConfig(season.config).overrides?.parameters ?? {}),
      )
      if (resolved.issues.length > 0) {
        return reply
          .code(500)
          .send({ error: `environment parameters are invalid: ${resolved.issues[0]?.message}` })
      }
      return { season_id: season?.id ?? null, values: resolved.values }
    },
  )

  // The public deployment branding the SPA reads once at startup, so the sidebar brand and the
  // document title reflect the operator's `SITE_NAME` rather than a hardcoded string. Unauthenticated
  // and read-only; extend this payload as more client-facing site config appears.
  app.get('/api/config', () => {
    const siteName = deps.siteName ?? DEFAULT_SITE_NAME
    return {
      site_name: siteName,
      site_short_name: deps.siteShortName ?? siteName,
      github_auth: deps.githubAuth ?? false,
    }
  })

  // The in-app student guides. Read-only and unauthenticated like `/api/config`: the frontend renders
  // the markdown and rewrites links, so these routes only serve the nav tree and raw page bytes. The
  // landing honors the optional class-index override; a page fetch is path-sanitized to `students/`.
  const docsDir = deps.docsDir ?? DEFAULT_DOCS_DIR
  const environmentGuidesDir = deps.environmentGuidesDir ?? DEFAULT_ENVIRONMENTS_DIR
  app.get('/api/docs/manifest', () => buildDocsManifest(docsDir, environmentGuidesDir))

  app.get('/api/docs/index', (_request, reply) => {
    try {
      return readDocsIndex(docsDir, deps.docsIndexFile)
    } catch (error) {
      if (error instanceof DocsIndexError) {
        return reply.code(500).send({ error: error.message })
      }
      throw error
    }
  })

  app.get<{ Params: { '*': string } }>('/api/docs/pages/*', (request, reply) => {
    const page = readDocsPage(docsDir, environmentGuidesDir, request.params['*'])
    if (page === null) {
      return reply.code(404).send({ error: 'documentation page not found' })
    }
    return page
  })

  // The frontend's single source for who-am-I and what-may-I-do: the session user and its derived
  // status, or a null user for an anonymous request. Anonymous is a 200 (not a 401), so the app shell
  // renders its signed-out state from a successful fetch. The frontend derives its capabilities from
  // `status`; the backend guards below are the real authority.
  app.get('/api/me', async (request) => {
    const user = await identity.resolveUser(request)
    if (user === null) {
      return { user: null }
    }
    return {
      // An explicit wire projection, not `return { user }`: the client contract is exactly these
      // fields, so a field later added to AuthUser for backend use is never auto-exposed here.
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        github_username: user.githubUsername ?? null,
        status: user.status,
      },
    }
  })

  app.post<{ Body: StartBody }>(
    '/api/sessions',
    { schema: START_SESSION_SCHEMA },
    async (request, reply) => {
      const user = await identity.requireActive(request, reply)
      if (user === undefined) {
        return
      }
      try {
        const result = await deps.orchestrator.start({
          userId: user.id,
          envId: request.body.env_id,
          seasonId: request.body.season_id,
          seed: request.body.seed,
          humanSlotTimeoutMs: request.body.human_slot_timeout_ms,
          parameters: request.body.parameters,
          slots: Object.fromEntries(
            Object.entries(request.body.slots).map(([slotId, assignment]) => [
              slotId,
              toSlotAssignment(assignment),
            ]),
          ),
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
    // The owner's display name beside the stable id, resolved at read time (omitted when unknown).
    const names = await deps.userDirectory.namesFor([session.user_id])
    return { ...session, ...optionalField('user_name', names.get(session.user_id)) }
  })

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    const user = await identity.requireActive(request, reply)
    if (user === undefined) {
      return
    }
    try {
      await deps.orchestrator.stop(request.params.id, user.id)
      return reply.code(204).send()
    } catch (error) {
      return replyError(reply, error)
    }
  })

  // The merged listing: each readable recording's header plus its retention metadata (owner, age,
  // pin state), optionally narrowed to one environment with `?env=`. Open to everyone (read-only).
  // Owner display names are attached here at the route boundary — one batched lookup over the whole
  // listing — so retention itself stays directory-free. Blind rating is enforced here too: a non-owner
  // (non-operator) viewing a still-playable recording gets its header attribution masked and its owner
  // fields stripped, so the public API never leaks what the UI hides. See recordings-view.ts.
  app.get<{ Querystring: { env?: string } }>('/api/recordings', async (request) => {
    const listings = await deps.retention.list({ env: request.query.env })
    const caller = await identity.resolveUser(request)
    const names = await deps.userDirectory.namesFor(
      listings.flatMap((listing) => (listing.user_id === null ? [] : [listing.user_id])),
    )
    // The play status of every season the listing references, so each recording's blind state is a
    // map lookup rather than a per-row query.
    const seasonIds = [
      ...new Set(
        listings.flatMap((listing) => (listing.season_id === null ? [] : [listing.season_id])),
      ),
    ]
    const playStatuses = new Map(
      await Promise.all(
        seasonIds.map(async (id) => [id, (await deps.storage.getSeason(id))?.play_status] as const),
      ),
    )
    return listings.map((listing) => {
      const header = listing.header as RecordingHeader
      const playStatus =
        listing.season_id === null ? undefined : playStatuses.get(listing.season_id)
      if (isBlindRecording(caller, playStatus, header.players)) {
        // Mask the seat attribution, drop the owner name, and keep the owner id only for the owner
        // (who needs it to recognize and pin their own recording).
        const maskedHeader =
          header.players === undefined
            ? header
            : { ...header, players: maskPlayers(header.players, caller?.id) }
        return {
          ...listing,
          header: maskedHeader,
          user_id: caller?.id === listing.user_id ? listing.user_id : null,
        }
      }
      const name = listing.user_id === null ? undefined : names.get(listing.user_id)
      return { ...listing, ...optionalField('user_name', name) }
    })
  })

  app.get<{ Params: { id: string } }>('/api/recordings/:id', async (request, reply) => {
    if (!(await deps.recordings.exists(request.params.id))) {
      return reply.code(404).send({ error: 'no such recording' })
    }
    // The raw stream is masked the same way the listing is: resolve the caller, find the producing
    // session's season, and if this is a blind view rewrite only the header line before streaming the
    // (unchanged) state lines. A non-blind view streams the file untouched, the fast common path.
    const caller = await identity.resolveUser(request)
    const header = await deps.recordings.readHeader(request.params.id)
    const players = header?.players
    const session = (await deps.storage.listSessions()).find(
      (row) => row.recording_id === request.params.id,
    )
    const playStatus =
      session?.season_id == null
        ? undefined
        : (await deps.storage.getSeason(session.season_id))?.play_status
    reply.type('application/x-ndjson')
    if (
      header === undefined ||
      players === undefined ||
      !isBlindRecording(caller, playStatus, players)
    ) {
      return reply.send(deps.recordings.stream(request.params.id))
    }
    const maskedHeaderLine = JSON.stringify({
      ...header,
      players: maskPlayers(players, caller?.id),
    })
    return reply.send(
      replaceHeaderLine(deps.recordings.stream(request.params.id), maskedHeaderLine),
    )
  })

  // Pin and unpin are owner-only and gate on the recording's retention row. They sit under
  // `requireUser` (not `requireActive`) because they are an owner's own-library actions already scoped
  // by the ownership check below; a pending user is admitted but owns no recordings to pin (they
  // cannot start sessions), so the looser gate is inert today. Pinning is refused with `pinned_quota`
  // once the user is at their pinned cap, so the per-user quota stays a hard bound on storage even
  // though pinned recordings are exempt from eviction.
  app.post<{ Params: { id: string } }>('/api/recordings/:id/pin', async (request, reply) => {
    const user = await identity.requireUser(request, reply)
    if (user === undefined) {
      return
    }
    return replyPin(reply, deps.retention.pin(request.params.id, user.id))
  })
  app.delete<{ Params: { id: string } }>('/api/recordings/:id/pin', async (request, reply) => {
    const user = await identity.requireUser(request, reply)
    if (user === undefined) {
      return
    }
    return replyPin(reply, deps.retention.unpin(request.params.id, user.id))
  })

  app.get<{ Params: { id: string } }>(
    '/api/sessions/:id/ws',
    { websocket: true },
    async (socket, request) => {
      // The session cookie rides the WebSocket upgrade on the same origin, so spectating is public and
      // ownership is decided by the resolved user. An anonymous socket attaches with a null user and
      // can never be the owner or hold the human seat.
      const user = await identity.resolveUser(request)
      const client: ClientSocket = {
        send: (data) => socket.send(data),
        close: () => socket.close(),
        get bufferedAmount() {
          return socket.bufferedAmount
        },
      }
      const attachment = deps.orchestrator.attach(request.params.id, client, user?.id ?? null)
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
      const user = await identity.requireActive(request, reply)
      if (user === undefined) {
        return
      }
      const input = admitSubmissionSource(request.body, deps.allowLocalSubmissions, reply)
      if (input === undefined) {
        return
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
      const user = await identity.requireActive(request, reply)
      if (user === undefined) {
        return
      }
      const input = admitSubmissionSource(request.body, deps.allowLocalSubmissions, reply)
      if (input === undefined) {
        return
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
          user_id: user.id,
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
  app.get<{ Querystring: { env?: string } }>('/api/submissions', async (request, reply) => {
    const user = await identity.requireUser(request, reply)
    if (user === undefined) {
      return
    }
    return deps.storage.listSubmissionsByUser(user.id, request.query.env)
  })

  // The current participant's cross-environment season status. Pending users may read their own
  // history, but the identity always comes from the signed session and never from a route parameter.
  registerMyAgentRoutes(app, { storage: deps.storage, identity })

  // One submission joined with its ordered per-stage validation log, so a poll is a single request.
  // Submission ids appear in the anonymous watch-list contract, so this route must not turn one of
  // those ids back into an owner/source lookup for an ordinary viewer.
  app.get<{ Params: { id: string } }>('/api/submissions/:id', async (request, reply) => {
    const user = await identity.requireUser(request, reply)
    if (user === undefined) {
      return
    }
    const submission = await deps.storage.getSubmission(request.params.id)
    if (submission === undefined) {
      return reply.code(404).send({ error: 'no such submission' })
    }
    if (submission.user_id !== user.id && user.status !== 'admin') {
      return reply.code(403).send({ error: 'submission access denied', code: 'forbidden' })
    }
    const checks = await deps.storage.listSubmissionChecks(submission.id)
    return { ...submission, checks }
  })

  // Viewer-specific watch choices for the play-open season. Public, but personalized only when a user
  // resolves: an anonymous caller gets the unpersonalized sequence with no rating status and no
  // operator extras; a signed-in viewer receives their rating state; an admin additionally receives
  // owner/source details. The submission window may point at another round, so it never drives this list.
  app.get<{ Params: { envId: string } }>(
    '/api/environments/:envId/watch-agents',
    async (request) => {
      const season = await deps.storage.getPublicPlaySeason(request.params.envId)
      if (season === undefined) {
        return []
      }
      const user = await identity.resolveUser(request)
      const operator = user?.status === 'admin'
      const submissions = await deps.storage.listActiveSubmissionsBySeason(season.id, 'ready')
      // Owner display names ride only in the operator extras; batch them once across the listing.
      const ownerNames = operator
        ? await deps.userDirectory.namesFor(submissions.map((submission) => submission.user_id))
        : new Map<string, string>()
      const viewerRatings =
        user === null
          ? new Set<string>()
          : new Set(
              (await deps.storage.listRatingsByRater(season.id, user.id))
                .filter((rating) => rating.agent_kind === 'submission')
                .flatMap((rating) =>
                  rating.agent_submission_id === null ? [] : [rating.agent_submission_id],
                ),
            )
      return submissions.map((submission, index) => {
        // Personalized rating state only when a user resolves; an anonymous caller carries none.
        const ratingStatus =
          user === null
            ? undefined
            : submission.user_id === user.id
              ? 'own'
              : viewerRatings.has(submission.id)
                ? 'rated'
                : 'unrated'
        return {
          submission_id: submission.id,
          anonymous_number: index + 1,
          ...optionalField('rating_status', ratingStatus),
          ...(operator
            ? {
                owner_id: submission.user_id,
                ...optionalField('owner_name', ownerNames.get(submission.user_id)),
                source_kind: submission.source_kind,
                repo_url: submission.repo_url,
                commit_sha: submission.commit_sha,
                local_path: submission.local_path,
                ref: submission.ref,
              }
            : {}),
        }
      })
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
      // The owner's rating prompt per season they submitted into, so the profile can show what each
      // round's raters were asked to evaluate. Keyed by the owner (not the caller), so any viewer sees
      // it; only non-blank prompts are returned.
      const seasonIds = [...new Set(submissions.map((submission) => submission.season_id))]
      const author_prompts: Record<string, string> = {}
      await Promise.all(
        seasonIds.map(async (seasonId) => {
          const row = await deps.storage.getAgentRatingPrompt(seasonId, request.params.ownerId)
          if (row !== undefined && row.prompt !== '') {
            author_prompts[seasonId] = row.prompt
          }
        }),
      )
      // The owner's display name beside the stable owner id, but only for an owner who actually has a
      // submission here — otherwise this open route would resolve a name for any id at all (pending,
      // banned, or never-submitted accounts), an id-to-name oracle. Omitted when the directory has no row.
      const ownerProfile =
        submissions.length === 0
          ? undefined
          : (await deps.userDirectory.profilesFor([request.params.ownerId])).get(
              request.params.ownerId,
            )
      return {
        env_id: request.params.envId,
        owner_id: request.params.ownerId,
        ...optionalField('owner_name', ownerProfile?.name),
        ...optionalField('owner_github', ownerProfile?.githubUsername),
        submission_season_id: submissionTarget?.id ?? null,
        play_season_id: playTarget?.id ?? null,
        submissions: detailed,
        author_prompts,
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
    identity,
    knownDepsVersions: deps.knownDepsVersions,
    snapshots: deps.submissionSnapshots,
    userDirectory: deps.userDirectory,
    llm: deps.llm,
    ...(deps.llmDevelopment === undefined
      ? {}
      : {
          llmDevelopment: {
            keys: deps.llmDevelopment.keys,
            ledger: deps.llmDevelopment.ledger,
          },
        }),
  })
  registerLeaderboardRoutes(app, {
    storage: deps.storage,
    identity,
    userDirectory: deps.userDirectory,
  })
  // Participant ratings and the author's per-season rating prompt are attributed to the resolved
  // identity. Rating writes require an active user; reads require any signed-in user.
  registerRatingRoutes(app, {
    storage: deps.storage,
    recordings: deps.recordings,
    identity,
    userDirectory: deps.userDirectory,
  })

  // Mount Better Auth at `/api/auth/*`, before the SPA fallback so the catch-all never shadows it.
  await registerAuthRoutes(app, { auth: deps.auth })

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
