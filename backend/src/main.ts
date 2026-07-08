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
import { DEV_ADMIN_EMAIL, DEV_ADMIN_PASSWORD, DEV_AUTH_SECRET, loadConfig } from './config.js'
import { DEPS_VERSION, KNOWN_DEPS_VERSIONS } from './deps-version.js'
import { createDockerDriver } from './driver/docker/index.js'
import { EnvironmentRegistry } from './environments.js'
import {
  persistPlacementsForCompletedRun,
  reconcileCompletedRunPlacements,
} from './leaderboards/placements.js'
import { RecordingsStore } from './recordings.js'
import { Retention } from './retention.js'
import { seedOpenSeasons } from './seasons-seed.js'
import { Orchestrator } from './session/orchestrator.js'
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

  // Open the app database and hand its raw connection to Better Auth so the auth tables live on the
  // same SQLite handle. Migrate the auth schema, then re-sync the bootstrap admin from configuration;
  // a seed refusal (an email collision) throws out of `main` and exits non-zero.
  const { storage, sqlite } = await openSqlite(config.dbPath)
  const auth = createAuth(sqlite, config.auth)
  await migrateAuthSchema(auth)
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
  // Seed one open season per environment at the current dependency-set version, so submissions
  // have an identity boundary and pinned deps_version. Idempotent across restarts.
  await seedOpenSeasons(storage, environments, DEPS_VERSION)
  const driver = await createDockerDriver(config.docker)
  const recordings = new RecordingsStore(resolve(config.recordingsDir))
  // The durable per-submission source snapshot: written once a submission passes its size + static
  // checks, then read to rebuild an evicted overlay and to serve operator downloads.
  const snapshots = new SubmissionSnapshotStore(resolve(config.submissionsDir))
  const retention = new Retention(storage, recordings, config, log)
  const overlayEviction = new OverlayEviction(driver, storage, config, log)
  // The submission source seam resolves and fetches participant code. The orchestrator needs it too,
  // to rebuild a submission's overlay (from the snapshot, falling back to git) when its image was evicted.
  const submissionSource = createSubmissionSource(config.submission)
  // The sweep runs at startup, on the interval, and after each session finalize (the only moment
  // the data grows); the orchestrator triggers the finalize sweep through this callback.
  const orchestrator = new Orchestrator(
    driver,
    storage,
    environments,
    config,
    log,
    () => {
      void retention.sweep()
    },
    submissionSource,
    snapshots,
  )

  // The workflow runner (Stage 6.4): the Docker-backed background engine that drives a triggered run's
  // schedule one container at a time. Reconcile first: any run a prior process death left non-terminal
  // is failed, then any completed run missing its placement snapshot is backfilled.
  await reconcileInterruptedRuns(storage, log)
  await reconcileCompletedRunPlacements(storage, log)
  const workflowRunner = createWorkflowRunner({
    driver,
    storage,
    environments,
    source: submissionSource,
    snapshots,
    sandbox: config.sandbox,
    recordingsDir: resolve(config.recordingsDir),
    imagePolicy: config.docker.imagePolicy,
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
    environments,
    recordings,
    retention,
    allowlist: config.sessionAllowlist,
    operatorAllowlist: config.operatorAllowlist,
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
      await orchestrator.shutdown()
      await validationWorker.whenIdle()
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
