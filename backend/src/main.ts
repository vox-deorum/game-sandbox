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
import { createDockerDriver } from './driver/docker/index.js'
import { EnvironmentRegistry } from './environments.js'
import { RecordingsStore } from './recordings.js'
import { Orchestrator } from './session/orchestrator.js'
import { openSqliteStorage } from './storage/sqlite.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const log = (message: string): void => {
    console.error(message)
  }

  const storage = await openSqliteStorage(config.dbPath)
  const environments = EnvironmentRegistry.load()
  const driver = await createDockerDriver(config.docker)
  const orchestrator = new Orchestrator(driver, storage, environments, config, log)
  const recordings = new RecordingsStore(resolve(config.recordingsDir))

  const app = await buildApp({
    orchestrator,
    environments,
    recordings,
    allowlist: config.sessionAllowlist,
  })
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
      await orchestrator.shutdown()
      await app.close()
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
