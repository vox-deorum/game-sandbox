/**
 * The Fastify composition root.
 *
 * Domain route modules own request parsing and response behavior. This file creates the shared
 * request identity, registers those modules in dependency order, and installs the production SPA
 * fallback last.
 */
import { existsSync } from 'node:fs'

import fastifyStatic from '@fastify/static'
import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'

import { registerAdminRoutes } from './admin/routes.js'
import type { Auth } from './auth/auth.js'
import { createRequestIdentity } from './auth/identity.js'
import { registerAuthRoutes } from './auth/routes.js'
import type { UserDirectory } from './auth/users.js'
import type { LlmOptions } from './config/config.js'
import { registerConfigRoutes } from './config/routes.js'
import { registerDocsRoutes } from './docs/routes.js'
import type { EnvironmentRegistry } from './environments/registry.js'
import { registerEnvironmentRoutes } from './environments/routes.js'
import { registerLeaderboardRoutes } from './leaderboards/routes.js'
import type { DevelopmentKeyService } from './llm/development-keys.js'
import { registerDevelopmentLlmRoutes } from './llm/development-routes.js'
import type { LlmHandler } from './llm/handler.js'
import { registerRecordingLlmRoutes } from './llm/recording-routes.js'
import { registerMyAgentRoutes } from './my-agents/routes.js'
import { registerRatingRoutes } from './ratings/routes.js'
import type { Retention } from './recordings/retention.js'
import { registerRecordingRoutes } from './recordings/routes.js'
import type { RecordingsStore } from './recordings/store.js'
import type { Orchestrator } from './session/orchestrator.js'
import { registerSessionRoutes } from './session/routes.js'
import type { Storage } from './storage/index.js'
import type { DevelopmentLedgerStore } from './storage/llm/development-ledger/store.js'
import type { ExecutionTelemetryStore } from './storage/llm/execution-telemetry.js'
import { registerSubmissionRoutes } from './submission/routes.js'
import type { SubmissionSnapshotStore } from './submission/snapshot-store.js'
import type { SubmissionSource } from './submission/source/index.js'
import type { SubmissionEnqueuer } from './submission/worker.js'
import type { WorkflowRunner } from './workflow/runner.js'

export interface AppDeps {
  orchestrator: Orchestrator
  /**
   * The deployment's display name, served to the SPA by `GET /api/config`. Tests and callers that
   * omit it use the same `Game Sandbox` default as `loadConfig`.
   */
  siteName?: string
  /**
   * The compact brand for space-sensitive chrome, also served by `GET /api/config`. It falls back to
   * {@link AppDeps.siteName}, then the deployment display-name default.
   */
  siteShortName?: string
  /**
   * Whether this deployment configured GitHub OAuth. It defaults to `false` when omitted.
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
  /** The storage seam used across route domains. */
  storage: Storage
  /** The submission-source seam used for reachability checks and source resolution. */
  submissionSource: SubmissionSource
  /** The submission-snapshot store used by operator download routes. */
  submissionSnapshots: SubmissionSnapshotStore
  /** The bounded validation worker that receives accepted submission jobs. */
  validationWorker: SubmissionEnqueuer
  /** Whether the development-only local-folder source is offered. */
  allowLocalSubmissions: boolean
  /**
   * The built frontend bundle to serve at the root. Production startup supplies it when the bundle
   * exists. Development and tests omit it.
   */
  frontendDir?: string
  /** The documentation root containing shared student guides. */
  docsDir?: string
  /** The package root containing canonical environment guides. */
  environmentGuidesDir?: string
  /** Optional class-index override served by `GET /api/docs/index`. */
  docsIndexFile?: string
  /** The Better Auth instance mounted at `/api/auth/*` and used by the request identity. */
  auth: Auth
  /** The display-name directory used to enrich stable user ids at response boundaries. */
  userDirectory: UserDirectory
  /** Current deployment LLM configuration used by admin validation and run-policy freezing. */
  llm: LlmOptions
  /** Public development-key and history routes. The handler is absent without upstream calling. */
  llmDevelopment?: {
    keys: DevelopmentKeyService
    handler?: LlmHandler
    ledger: DevelopmentLedgerStore
  }
  /** Retained official telemetry reader. Associated recordings fail closed when it is unavailable. */
  officialTelemetry?: Pick<ExecutionTelemetryStore, 'readAssociatedCalls'>
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(websocket)

  // Resolve every request through one shared identity so its per-request cache covers all domains.
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

  registerEnvironmentRoutes(app, {
    environments: deps.environments,
    storage: deps.storage,
  })
  registerConfigRoutes(app, {
    ...(deps.siteName === undefined ? {} : { siteName: deps.siteName }),
    ...(deps.siteShortName === undefined ? {} : { siteShortName: deps.siteShortName }),
    ...(deps.githubAuth === undefined ? {} : { githubAuth: deps.githubAuth }),
  })
  registerDocsRoutes(app, {
    ...(deps.docsDir === undefined ? {} : { docsDir: deps.docsDir }),
    ...(deps.environmentGuidesDir === undefined
      ? {}
      : { environmentGuidesDir: deps.environmentGuidesDir }),
    ...(deps.docsIndexFile === undefined ? {} : { docsIndexFile: deps.docsIndexFile }),
  })
  registerSessionRoutes(app, {
    orchestrator: deps.orchestrator,
    identity,
    userDirectory: deps.userDirectory,
  })
  registerRecordingRoutes(app, {
    recordings: deps.recordings,
    retention: deps.retention,
    storage: deps.storage,
    identity,
    userDirectory: deps.userDirectory,
  })
  registerSubmissionRoutes(app, {
    storage: deps.storage,
    submissionSource: deps.submissionSource,
    validationWorker: deps.validationWorker,
    allowLocalSubmissions: deps.allowLocalSubmissions,
    identity,
    userDirectory: deps.userDirectory,
  })
  registerMyAgentRoutes(app, { storage: deps.storage, identity })

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
    environments: deps.environments,
  })
  registerRatingRoutes(app, {
    storage: deps.storage,
    recordings: deps.recordings,
    identity,
    userDirectory: deps.userDirectory,
  })

  // Better Auth remains before the SPA fallback. Its raw JSON parser stays in its child scope.
  await registerAuthRoutes(app, { auth: deps.auth, identity })

  // Keep the production SPA fallback on the root instance and after every API route.
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
