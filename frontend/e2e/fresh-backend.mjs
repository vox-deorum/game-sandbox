import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'

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

// Stage 9's browser journeys use the same local OpenAI-compatible upstream as the integration
// suite. The suite intentionally treats it as part of the shared backend fixture: if it cannot boot,
// the web server fails before any spec runs instead of leaving the backend partially configured.
// Start it first so the backend receives its dynamic loopback URL before configuration loads.
const stub = spawn(
  'node',
  ['--import', 'tsx', 'backend/test/integration/support/llm-upstream-server.ts'],
  {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, LLM_STUB_PORT: '0' },
  },
)

const upstreamUrl = await new Promise((resolve, reject) => {
  let output = ''
  let settled = false
  function fail(error) {
    if (settled) return
    settled = true
    stub.kill()
    reject(error)
  }
  const timeout = setTimeout(() => fail(new Error('LLM stub did not report readiness')), 20_000)
  stub.stdout.setEncoding('utf8')
  stub.stdout.on('data', (chunk) => {
    output += chunk
    const match = output.match(/LLM stub listening (http:\/\/127\.0\.0\.1:\d+)/)
    if (match === null || settled) return
    settled = true
    clearTimeout(timeout)
    resolve(match[1])
  })
  stub.on('exit', (code) => {
    clearTimeout(timeout)
    fail(new Error(`LLM stub exited before readiness (${code ?? 'unknown'})`))
  })
  stub.on('error', (error) => {
    clearTimeout(timeout)
    fail(error)
  })
})

// Hand off to the real backend, inheriting stdio so Playwright still sees the "backend listening" line
// it waits on. `shell: true` lets the npm launcher resolve on Windows.
const child = spawn('npm', ['run', 'start', '--workspace', '@game-sandbox/backend'], {
  stdio: 'inherit',
  env: { ...process.env, LLM_UPSTREAM_URL: `${upstreamUrl}/v1` },
  shell: true,
})

function stop(signal) {
  child.kill(signal)
  stub.kill(signal)
}

child.on('exit', (code, signal) => {
  stub.kill()
  if (signal !== null) {
    process.kill(process.pid, signal)
  } else {
    process.exit(code ?? 0)
  }
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop(signal))
}
