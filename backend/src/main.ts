/**
 * The backend process entrypoint: load config, open storage, build the driver and orchestrator,
 * assemble the app, listen, and tear everything down on a signal.
 *
 * Run from source through tsx (`npm run dev` / `npm run start`); a compiled build is a deployment
 * concern deferred until a real deployment exists. The Docker driver is the only execution driver
 * in this stage, so it is wired in directly here; nothing above the driver interface depends on it.
 */
import { resolve } from 'node:path'

import { buildApp } from './app.js'
import { createAuth } from './auth/auth.js'
import { migrateAuthSchema } from './auth/migrate.js'
import { ensureAdminUser } from './auth/seed-admin.js'
import { createUserDirectory, createUserStatusReader } from './auth/users.js'
import { DEV_ADMIN_EMAIL, DEV_ADMIN_PASSWORD, DEV_AUTH_SECRET, loadConfig } from './config.js'
import { DEPS_VERSION, KNOWN_DEPS_VERSIONS } from './deps-version.js'
import { createDockerDriver } from './driver/docker/index.js'
import { EnvironmentRegistry } from './environments.js'
import {
  persistPlacementsForCompletedRun,
  reconcileCompletedRunPlacements,
} from './leaderboards/placements.js'
import {
  buildLlmListener,
  DevelopmentKeyService,
  KeyRegistry,
  LlmHandler,
  LlmMeter,
  TiktokenCounter,
  UpstreamCaller,
} from './llm/index.js'
import { RecordingsStore } from './recordings.js'
import { Retention, reclaimOrphanedOfficialTelemetry } from './retention.js'
import { seedOpenSeasons } from './seasons-seed.js'
import { createOfficialGrantIssuer } from './session/official-grants.js'
import { Orchestrator } from './session/orchestrator.js'
import { DevelopmentLedgerStore, ExecutionTelemetryStore } from './storage/llm/index.js'
import { openSqlite } from './storage/sqlite.js'
import { OverlayEviction } from './submission/overlay-eviction.js'
import { SubmissionSnapshotStore } from './submission/snapshot-store.js'
import { createSubmissionSource } from './submission/source/index.js'
import { ValidationWorker } from './submission/worker.js'
import { reconcileInterruptedRuns } from './workflow/runner.js'
import { createWorkflowRunner } from './workflow/workflow-runner.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const log = (message: string): void => {
    console.error(message)
  }

  // Stage 9.1 owns an internal listener separate from the public application. It remains absent in
  // deployments that configure no upstream or no public model alias, preserving the pre-LLM path.
  const llmConfigured =
    config.llm.upstreamUrl !== undefined && Object.keys(config.llm.models).length > 0
  // The meter and durable stores also serve development history and official recording reads. Keep
  // them available when active upstream calling is not configured.
  const llmMeter = new LlmMeter({ recoveryIntervalMs: config.llm.meterRecoveryIntervalMs, log })
  const llmTokenizer = llmConfigured ? new TiktokenCounter(config.llm.tiktokenEncoding) : undefined
  // The worst-case wall time of one logical upstream request: every attempt plus its exponential
  // backoff. Future watchdog integration can use it to bound one active call's deadline extension.
  const upstreamMaxRequestMs =
    config.llm.upstreamTimeoutMs * (config.llm.upstreamMaxRetries + 1) +
    config.llm.upstreamRetryIntervalMs * 2 ** config.llm.upstreamMaxRetries
  const llmRegistry = llmConfigured
    ? new KeyRegistry(undefined, { maxRequestMs: upstreamMaxRequestMs })
    : undefined
  const llmHandler =
    llmConfigured && llmTokenizer !== undefined
      ? new LlmHandler({
          meter: llmMeter,
          tokenizer: llmTokenizer,
          upstream: new UpstreamCaller({
            baseURL: config.llm.upstreamUrl as string,
            apiKey: config.llm.upstreamKey,
            timeoutMs: config.llm.upstreamTimeoutMs,
            maxRetries: config.llm.upstreamMaxRetries,
            retryIntervalMs: config.llm.upstreamRetryIntervalMs,
          }),
          options: {
            defaultMaxOutputTokens: config.llm.defaultMaxOutputTokens,
            maxOutputTokens: config.llm.maxOutputTokens,
          },
        })
      : undefined
  const llmListener =
    llmRegistry !== undefined && llmHandler !== undefined
      ? await buildLlmListener({
          registry: llmRegistry,
          handler: llmHandler,
          log,
        })
      : undefined

  // Open the app database and hand its raw connection to Better Auth so the auth tables live on the
  // same SQLite handle. Migrate the auth schema, then re-sync the bootstrap admin from configuration;
  // a seed refusal (an email collision) throws out of `main` and exits non-zero.
  const { storage, sqlite } = await openSqlite(config.dbPath)
  const auth = createAuth(sqlite, config.auth)
  await migrateAuthSchema(auth)
  // The display-name directory reads the library-owned `user` table on the same shared connection;
  // routes and the two launch paths batch user ids through it wherever an id crosses to the UI.
  const userDirectory = createUserDirectory(sqlite)
  const readUserStatus = createUserStatusReader(sqlite)
  await ensureAdminUser(
    auth,
    {
      email: config.auth.adminEmail,
      password: config.auth.adminPassword,
      name: config.auth.adminName,
    },
    log,
  )
  const environments = EnvironmentRegistry.load()
  const officialTelemetry = new ExecutionTelemetryStore(resolve(config.dataDir, 'llm'))
  const developmentLedger = new DevelopmentLedgerStore(
    resolve(config.dataDir, 'llm', 'development'),
  )
  const officialGrantIssuer =
    llmRegistry === undefined
      ? undefined
      : createOfficialGrantIssuer(llmRegistry, officialTelemetry)
  const developmentKeys = new DevelopmentKeyService({
    storage,
    environments,
    llm: config.llm,
    meter: llmMeter,
    ledger: developmentLedger,
    publicOrigin: config.auth.publicOrigin,
    readUserStatus,
  })
  // Seed one open season per environment at the current dependency-set version, so submissions
  // have an identity boundary and pinned deps_version. Idempotent across restarts.
  await seedOpenSeasons(storage, environments, DEPS_VERSION)
  const driver = await createDockerDriver(
    config.docker,
    llmConfigured ? config.llm.internalPort : undefined,
  )
  const recordings = new RecordingsStore(resolve(config.recordingsDir))
  // The durable per-submission source snapshot: written once a submission passes its size + static
  // checks, then read to rebuild an evicted overlay and to serve operator downloads.
  const snapshots = new SubmissionSnapshotStore(resolve(config.submissionsDir))
  // Retention also reclaims each execution telemetry scope with the last recording referencing it.
  const retention = new Retention(storage, recordings, config, log, undefined, officialTelemetry)
  const overlayEviction = new OverlayEviction(driver, storage, config, log)
  // The submission source seam resolves and fetches participant code. The orchestrator needs it too,
  // to rebuild a submission's overlay (from the snapshot, falling back to git) when its image was evicted.
  const submissionSource = createSubmissionSource(config.submission)
  // The sweep runs at startup, on the interval, and after each session finalize (the only moment
  // the data grows); the orchestrator triggers the finalize sweep through this callback.
  const orchestrator = new Orchestrator({
    driver,
    storage,
    environments,
    config,
    log,
    onSessionFinalized: () => {
      void retention.sweep()
    },
    submissionSource,
    submissionSnapshots: snapshots,
    userDirectory,
    officialGrantIssuer,
    deleteLlmScope: (scopeId) => officialTelemetry.deleteScope(scopeId),
  })

  // The workflow runner (Stage 6.4): the Docker-backed background engine that drives a triggered run's
  // schedule one container at a time. Reconcile first: any run a prior process death left non-terminal
  // is failed, then any completed run missing its placement snapshot is backfilled.
  await reconcileInterruptedRuns(storage, log)
  await reconcileCompletedRunPlacements(storage, log)
  await reclaimOrphanedOfficialTelemetry(storage, officialTelemetry, log)
  const workflowRunner = createWorkflowRunner({
    driver,
    storage,
    environments,
    source: submissionSource,
    snapshots,
    sandbox: config.sandbox,
    recordingsDir: resolve(config.recordingsDir),
    imagePolicy: config.docker.imagePolicy,
    userDirectory,
    llmInternalPort: llmConfigured ? config.llm.internalPort : undefined,
    officialGrantIssuer,
    officialTelemetry,
    log,
    // A completed run is the board's new source: snapshot its ranked placements, then sweep retention
    // (the run grew the recordings and may have superseded a prior run's, freeing them). Placements
    // only change on a `completed` run; other terminal statuses just sweep.
    onRunComplete: async (runId, status) => {
      if (status === 'completed') {
        try {
          await persistPlacementsForCompletedRun(storage, runId)
        } catch (error) {
          log(`run ${runId}: persisting placements failed: ${String(error)}`)
        }
      }
      await retention.sweep()
    },
  })

  // The submission pipeline (Stage 5): the bounded worker drives the source seam through the four
  // validation stages, sweeping overlay images after each build. The accepted manifest versions come
  // from the explicit base-image registry, so validation cannot promise an image the driver cannot serve.
  const validationWorker = new ValidationWorker({
    driver,
    storage,
    source: submissionSource,
    snapshots,
    submissionMaxSizeBytes: config.submission.submissionMaxSizeBytes,
    sandbox: config.sandbox,
    loadCheckTimeoutMs: config.submission.loadCheckTimeoutMs,
    knownTemplateVersions: KNOWN_DEPS_VERSIONS,
    log,
    onOverlayBuilt: () => {
      void overlayEviction.sweep()
    },
  })

  const app = await buildApp({
    orchestrator,
    siteName: config.siteName,
    siteShortName: config.siteShortName,
    githubAuth: config.auth.github !== undefined,
    environments,
    recordings,
    retention,
    knownDepsVersions: KNOWN_DEPS_VERSIONS,
    workflowRunner,
    frontendDir: config.frontendDir,
    docsDir: config.docsDir,
    docsIndexFile: config.docsIndexFile,
    storage,
    submissionSource,
    submissionSnapshots: snapshots,
    validationWorker,
    allowLocalSubmissions: config.submission.allowLocalSubmissions,
    auth,
    userDirectory,
    llm: config.llm,
    officialTelemetry,
    llmDevelopment: {
      keys: developmentKeys,
      ...(llmHandler === undefined ? {} : { handler: llmHandler }),
      ledger: developmentLedger,
    },
  })
  retention.start()
  overlayEviction.start()
  // Re-enqueue active pending submissions stranded by a prior restart, then accept new ones.
  await validationWorker.start()

  // An explicitly opted-in insecure-development startup binds a loopback interface only and runs on
  // published credentials; warn loudly for each published value actually in effect, so it can never
  // be mistaken for a real deployment.
  if (config.auth.insecureDevelopment) {
    log(`AUTH_ALLOW_INSECURE_DEFAULTS is on: listening on loopback ${config.listenHost} only`)
    if (config.auth.secret === DEV_AUTH_SECRET) {
      log('WARNING: using the published development AUTH_SECRET; never deploy with it')
    }
    if (config.auth.adminEmail === DEV_ADMIN_EMAIL) {
      log(`WARNING: using the published development ADMIN_EMAIL ${DEV_ADMIN_EMAIL}`)
    }
    if (config.auth.adminPassword === DEV_ADMIN_PASSWORD) {
      log('WARNING: using the published development ADMIN_PASSWORD; never deploy with it')
    }
  }

  if (llmListener !== undefined) {
    await llmListener.listen({ port: config.llm.internalPort, host: '0.0.0.0' })
    log(`internal LLM proxy listening on 0.0.0.0:${config.llm.internalPort}`)
  }
  await app.listen({ port: config.port, host: config.listenHost })
  log(`backend listening on ${config.listenHost}:${config.port}`)

  let stopping = false
  const shutdown = (signal: string): void => {
    if (stopping) {
      return
    }
    stopping = true
    log(`received ${signal}, shutting down`)
    void (async () => {
      retention.stop()
      overlayEviction.stop()
      // Stop accepting routes before draining the worker so no submit can enqueue during shutdown.
      await app.close()
      // Revoke official grants while the internal listener and meter are still alive. Revocation
      // aborts requests that remain safely cancellable and drains every reservation finalizer.
      await Promise.all([workflowRunner.shutdown(), orchestrator.shutdown()])
      await llmListener?.close()
      llmMeter.close()
      llmTokenizer?.close()
      await validationWorker.whenIdle()
      officialTelemetry.close()
      developmentLedger.close()
      await storage.close()
      process.exit(0)
    })()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
