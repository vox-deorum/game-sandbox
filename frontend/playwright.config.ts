import { fileURLToPath } from 'node:url'

import { defineConfig, devices } from '@playwright/test'

/**
 * The browser end-to-end suite: Chromium against the real backend, which serves the built frontend
 * from the same origin (the production path) so there is one server and no proxy. The backend launches
 * real session containers, so this suite needs a Docker daemon — the same gate as `backend:integration`
 * — and is wired into CI as the `frontend-e2e` job (see scripts/ci.py). The `frontend-e2e` job builds
 * the frontend and the session base image before invoking this config.
 *
 * One server serves the built bundle. Identity is a Better Auth session cookie (Stage 12): the suite's
 * fixtures sign in as the seeded bootstrap admin and create member accounts through the roster endpoint
 * (see e2e/support/fixtures.ts), so there is no allowlist to vary across servers.
 */
const DIST = fileURLToPath(new URL('./dist', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
// A launcher that wipes the backend's data dir before starting it, so every run boots a fresh database
// (see e2e/fresh-backend.mjs). It must wipe in the launch command, not a global-setup hook: Playwright
// starts its web servers before global setup, so by then the backend already holds the db file open.
const FRESH_BACKEND = `node ${JSON.stringify(fileURLToPath(new URL('./e2e/fresh-backend.mjs', import.meta.url)))}`

const MAIN_PORT = 8090

/**
 * The renderer needs a WebGL context (PixiJS skips its app entirely without one — see
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
      }),
      url: `http://127.0.0.1:${MAIN_PORT}/api/me`,
      // Never reattach to a leftover backend: the launcher just wiped the database for a fresh run, so
      // a fresh DB requires a fresh server. Playwright shuts down the servers it starts.
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
