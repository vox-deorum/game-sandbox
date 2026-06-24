import { fileURLToPath } from 'node:url'

import { defineConfig, devices } from '@playwright/test'

/**
 * The browser end-to-end suite: Chromium against the real backend, which serves the built frontend
 * from the same origin (the production path) so there is one server and no proxy. The backend launches
 * real session containers, so this suite needs a Docker daemon — the same gate as `backend:integration`
 * — and is wired into CI as the `frontend-e2e` job (see scripts/ci.py). The `frontend-e2e` job builds
 * the frontend and the session base image before invoking this config.
 *
 * Two servers run so the allowlist variation has a context where the auto-logged user is not on the
 * list: `main` allows `dev-user`, `restricted` allows no one. Both serve the same built bundle.
 */
const DIST = fileURLToPath(new URL('./dist', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
// A launcher that wipes the backend's data dir before starting it, so every run boots a fresh database
// (see e2e/fresh-backend.mjs). It must wipe in the launch command, not a global-setup hook: Playwright
// starts its web servers before global setup, so by then the backend already holds the db file open.
const FRESH_BACKEND = `node ${JSON.stringify(fileURLToPath(new URL('./e2e/fresh-backend.mjs', import.meta.url)))}`

const MAIN_PORT = 8090
const RESTRICTED_PORT = 8091

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
  allowlist: string,
  dataSubdir: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    PORT: String(port),
    FRONTEND_DIST: DIST,
    DATA_DIR: fileURLToPath(new URL(`./e2e/.data/${dataSubdir}`, import.meta.url)),
    SESSION_ALLOWLIST: allowlist,
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
      // The main backend also enables the dev-only local-folder submission source so submission.spec
      // can drive the real validate-and-build pipeline from a checked-in fixture, with no network.
      // The allowlist names the rating judges alongside dev-user so the leaderboards arc can post the
      // several ratings an agent needs to earn a ranked Human Ratings row (see e2e/support/names.ts).
      env: backendEnv(MAIN_PORT, 'dev-user,jordan-skywatch,morgan-aileron,taylor-gust', 'main', {
        ALLOW_LOCAL_SUBMISSIONS: 'true',
      }),
      url: `http://127.0.0.1:${MAIN_PORT}/api/me`,
      // Never reattach to a leftover backend: the launcher just wiped the database for a fresh run, so
      // a fresh DB requires a fresh server. Playwright shuts down the servers it starts.
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: FRESH_BACKEND,
      cwd: REPO_ROOT,
      env: backendEnv(RESTRICTED_PORT, 'nobody', 'restricted'),
      url: `http://127.0.0.1:${RESTRICTED_PORT}/api/me`,
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
      testIgnore: /allowlist\.spec\.ts/,
    },
    {
      name: 'restricted',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://127.0.0.1:${RESTRICTED_PORT}`,
        launchOptions: { args: SOFTWARE_WEBGL_ARGS },
      },
      testMatch: /allowlist\.spec\.ts/,
    },
  ],
})
