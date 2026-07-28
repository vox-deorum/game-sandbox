import { fileURLToPath } from 'node:url'

import { defineConfig, devices } from '@playwright/test'

/**
 * The browser end-to-end suite: Chromium against the real backend and a scripted Python loopback
 * bridge. The backend serves the production bundle from the same origin and launches real session
 * containers. The loopback bridge serves the standalone local bundle and exercises its shared live
 * protocol. The suite is wired into CI as the Docker-gated `frontend-e2e` job (see scripts/ci.py).
 *
 * The backend serves the production bundle. Identity is a Better Auth session cookie (Stage 12): the suite's
 * fixtures sign in as the seeded bootstrap admin and create member accounts through the roster endpoint
 * (see e2e/support/fixtures.ts), so there is no allowlist to vary across servers.
 */
const DIST = fileURLToPath(new URL('./dist', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
// A launcher that wipes the backend's data dir before starting it, so every run boots a fresh database
// (see e2e/fresh-backend.mjs). It must wipe in the launch command, not a global-setup hook: Playwright
// starts its web servers before global setup, so by then the backend already holds the db file open.
const FRESH_BACKEND = `node ${JSON.stringify(fileURLToPath(new URL('./e2e/fresh-backend.mjs', import.meta.url)))}`
const LOCAL_BRIDGE = `uv run python ${JSON.stringify(fileURLToPath(new URL('./e2e/local-play-bridge.py', import.meta.url)))} --port 8091`

const MAIN_PORT = 8090

/**
 * The renderer needs a WebGL context (PixiJS skips its app entirely without one, see
 * PixiRenderer.hasWebGL), but headless Chromium on a GPU-less CI runner has no hardware GL. These
 * flags route GL through ANGLE's SwiftShader software backend so the canvas mounts as it does on a
 * desktop. `--enable-unsafe-swiftshader` opts in to SwiftShader after recent Chromium versions began
 * gating it behind that flag.
 */
const SOFTWARE_WEBGL_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
]

function backendEnv(
  port: number,
  dataSubdir: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    PORT: String(port),
    FRONTEND_DIST: DIST,
    DATA_DIR: fileURLToPath(new URL(`./e2e/.data/${dataSubdir}`, import.meta.url)),
    // The backend embeds Better Auth (Stage 12.1), which refuses to start without an explicit public
    // origin, secret, and bootstrap credentials. This loopback e2e server opts into the published
    // development defaults, so the bootstrap admin is `admin@example.com` / `admin-dev-password` (see
    // e2e/support/auth.ts); the loopback origin binds the listener to `127.0.0.1`, matching both the
    // health-check URL and the project baseURL the browser loads from.
    AUTH_ALLOW_INSECURE_DEFAULTS: 'true',
    PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
    // A short idle window keeps a forgotten session from holding a container across the run.
    SESSION_IDLE_TIMEOUT_MS: '30000',
    // The load check itself is a sub-second import-and-construct, but it first cold-starts a
    // container; on a busy local Docker daemon that launch alone can approach the 30s default and
    // flake the submission pipeline. Give it headroom (still well inside waitForTerminal's 150s poll).
    SUBMISSION_LOAD_CHECK_TIMEOUT_MS: '90000',
    ...extra,
  }
}

export default defineConfig({
  testDir: './e2e',
  // A real container session takes a few seconds to come up; give each test room.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  webServer: [
    {
      command: FRESH_BACKEND,
      cwd: REPO_ROOT,
      // The backend also enables the dev-only local-folder submission source so submission.spec can
      // drive the real validate-and-build pipeline from a checked-in fixture, with no network.
      env: backendEnv(MAIN_PORT, 'main', {
        ALLOW_LOCAL_SUBMISSIONS: 'true',
        LLM_UPSTREAM_KEY: 'upstream-secret',
        LLM_MODEL_SMALL: 'provider-small',
        LLM_COST_WEIGHT_SMALL: '2',
        LLM_SESSION_TOKEN_BUDGET: '10000',
        LLM_SESSION_RATE_LIMIT_RPM: '60',
        LLM_DEVELOPMENT_TOKEN_BUDGET: '10000',
        LLM_DEVELOPMENT_RATE_LIMIT_RPM: '60',
        LLM_DEFAULT_MAX_OUTPUT_TOKENS: '16',
        LLM_MAX_OUTPUT_TOKENS: '32',
        LLM_UPSTREAM_TIMEOUT_MS: '5000',
        LLM_UPSTREAM_MAX_RETRIES: '2',
        LLM_TIKTOKEN_ENCODING: 'cl100k_base',
        // This suite already reserves MAIN_PORT and permits only one local run at a time. Keep the
        // internal listener fixed under that same constraint so Docker relays have one known target.
        LLM_INTERNAL_PORT: '9472',
      }),
      url: `http://127.0.0.1:${MAIN_PORT}/api/me`,
      // Never reattach to a leftover backend: the launcher just wiped the database for a fresh run, so
      // a fresh DB requires a fresh server. Playwright shuts down the servers it starts.
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: LOCAL_BRIDGE,
      cwd: REPO_ROOT,
      url: 'http://127.0.0.1:8091/api/environments',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: 'main',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://127.0.0.1:${MAIN_PORT}`,
        launchOptions: { args: SOFTWARE_WEBGL_ARGS },
      },
    },
  ],
})
