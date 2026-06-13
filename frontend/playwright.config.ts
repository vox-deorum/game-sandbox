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
const BACKEND = 'npm run start --workspace @game-sandbox/backend'

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

function backendEnv(port: number, allowlist: string, dataSubdir: string): Record<string, string> {
  return {
    PORT: String(port),
    FRONTEND_DIST: DIST,
    DATA_DIR: fileURLToPath(new URL(`./e2e/.data/${dataSubdir}`, import.meta.url)),
    SESSION_ALLOWLIST: allowlist,
    // A short idle window keeps a forgotten session from holding a container across the run.
    SESSION_IDLE_TIMEOUT_MS: '30000',
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
      command: BACKEND,
      cwd: REPO_ROOT,
      env: backendEnv(MAIN_PORT, 'dev-user', 'main'),
      url: `http://127.0.0.1:${MAIN_PORT}/api/me`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: BACKEND,
      cwd: REPO_ROOT,
      env: backendEnv(RESTRICTED_PORT, 'nobody', 'restricted'),
      url: `http://127.0.0.1:${RESTRICTED_PORT}/api/me`,
      reuseExistingServer: !process.env.CI,
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
