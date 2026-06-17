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
import { loadConfig } from './config.js'
import { DEPS_VERSION } from './deps-version.js'
import { createDockerDriver } from './driver/docker/index.js'
import { EnvironmentRegistry } from './environments.js'
import { seedOpenIterations } from './iterations-seed.js'
import {
  persistPlacementsForCompletedRun,
  reconcileCompletedRunPlacements,
} from './leaderboards/placements.js'
import { RecordingsStore } from './recordings.js'
import { Retention } from './retention.js'
import { Orchestrator } from './session/orchestrator.js'
import { openSqliteStorage } from './storage/sqlite.js'
import { OverlayEviction } from './submission/overlay-eviction.js'
import { createSubmissionSource } from './submission/source/index.js'
import { ValidationWorker } from './submission/worker.js'
import { reconcileInterruptedRuns } from './workflow/runner.js'
import { createWorkflowRunner } from './workflow/workflow-runner.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const log = (message: string): void => {
    console.error(message)
  }

  const storage = await openSqliteStorage(config.dbPath)
  const environments = EnvironmentRegistry.load()
  // Seed one open iteration per environment at the current dependency-set version, so submissions
  // have an identity boundary and pinned deps_version. Idempotent across restarts.
  await seedOpenIterations(storage, environments, DEPS_VERSION)
  const driver = await createDockerDriver(config.docker)
  const recordings = new RecordingsStore(resolve(config.recordingsDir))
  const retention = new Retention(storage, recordings, config, log)
  const overlayEviction = new OverlayEviction(driver, storage, config, log)
  // The submission source seam resolves and fetches participant code. The orchestrator needs it too,
  // to rebuild a submission's overlay when the cached image was evicted before a watch run.
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
  // validation stages, sweeping overlay images after each build. The deployment has a base image for
  // the current dependency-set version only.
  const validationWorker = new ValidationWorker({
    driver,
    storage,
    source: submissionSource,
    sandbox: config.sandbox,
    loadCheckTimeoutMs: config.submission.loadCheckTimeoutMs,
    knownTemplateVersions: new Set([DEPS_VERSION]),
    log,
    onOverlayBuilt: () => {
      void overlayEviction.sweep()
    },
  })

  const app = await buildApp({
    orchestrator,
    environments,
    recordings,
    retention,
    allowlist: config.sessionAllowlist,
    operatorAllowlist: config.operatorAllowlist,
    workflowRunner,
    frontendDir: config.frontendDir,
    storage,
    submissionSource,
    validationWorker,
    allowLocalSubmissions: config.submission.allowLocalSubmissions,
  })
  retention.start()
  overlayEviction.start()
  // Re-enqueue active pending submissions stranded by a prior restart, then accept new ones.
  await validationWorker.start()
  await app.listen({ port: config.port, host: '0.0.0.0' })
  log(`backend listening on :${config.port}`)

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
