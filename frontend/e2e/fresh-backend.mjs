import { rmSync } from 'node:fs'
import { spawn } from 'node:child_process'

/**
 * Launch an e2e backend on a fresh database.
 *
 * Playwright starts its `webServer` commands *before* global setup and the tests, and the backend
 * opens its SQLite file the moment it boots — so the only reliable place to wipe the database is here,
 * inside the launch command, before that process starts. (Deleting the file from a global-setup hook
 * fails: by then the backend already holds it open, which on Windows throws `EBUSY`.) Each server
 * passes its own `DATA_DIR`, so this removes just that backend's database and recordings; the backend
 * then recreates the schema and reseeds the `Playground` season on startup.
 *
 * In CI the data dir does not exist yet, so the wipe is a harmless no-op. This is why the specs no
 * longer need timestamped names: a run can never collide with a prior run's data.
 */
const dataDir = process.env.DATA_DIR
if (dataDir !== undefined && dataDir !== '') {
  rmSync(dataDir, { recursive: true, force: true })
}

// Hand off to the real backend, inheriting stdio so Playwright still sees the "backend listening" line
// it waits on. `shell: true` lets the npm launcher resolve on Windows.
const child = spawn('npm', ['run', 'start', '--workspace', '@game-sandbox/backend'], {
  stdio: 'inherit',
  env: process.env,
  shell: true,
})

child.on('exit', (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal)
  } else {
    process.exit(code ?? 0)
  }
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
