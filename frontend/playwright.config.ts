import { readdirSync } from 'node:fs'
import { join } from 'node:path'
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

const MAIN_USE = {
  ...devices['Desktop Chrome'],
  baseURL: `http://127.0.0.1:${MAIN_PORT}`,
  launchOptions: { args: SOFTWARE_WEBGL_ARGS },
}

/**
 * One project per group, so a change can run just the slice it touches: `playwright test --project
 * hearts`. With no `--project` every group runs.
 *
 * A group is any directory under `e2e/` holding at least one spec, which makes the filesystem the only
 * registry: adding a directory with a spec in it adds a project, and `support/` and `fixtures/` are
 * excluded because they hold no specs rather than because a list says so. scripts/ci.py discovers the
 * same set the same way, so the two runners cannot drift apart.
 *
 * Every group depends on `season-fixture`: journey.spec.ts asserts against the Playground overrides it
 * writes (pipe gap 90, decision limit 750). Playwright runs a setup project once per run rather than
 * once per dependent project, so selecting several groups still pays for it once. Never pass
 * `--no-deps`, which would skip that setup and fail those assertions against an unmodified season.
 *
 * The long season arcs carry a `@slow` tag rather than living in a project or a file suffix, so each
 * stays beside its siblings in the environment it belongs to. Drop them with `--grep-invert @slow`.
 * This config deliberately applies no filter of its own: a default that hid `@slow` would make a bare
 * `npm run e2e` quietly produce a run missing every released season.
 *
 * `crane-reach` is named after its spec, not its `skirmish_crane` environment id, so every group name
 * matches the file it contains.
 */
const E2E_DIR = fileURLToPath(new URL('./e2e', import.meta.url))
const GROUPS = readdirSync(E2E_DIR, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isDirectory() &&
      readdirSync(join(E2E_DIR, entry.name)).some((file) => file.endsWith('.spec.ts')),
  )
  .map((entry) => entry.name)
  .sort()

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
    // health-check URL and the project baseURL the browser loads from. LOAD_LOCAL_ENV=false makes the
    // backend skip any repository-root `.env` a local deployment left behind, so that file cannot
    // override the development credentials above (see backend/src/config/env-files.ts).
    AUTH_ALLOW_INSECURE_DEFAULTS: 'true',
    LOAD_LOCAL_ENV: 'false',
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
  // One project per group is not an invitation to parallelize. Every group shares one database, one
  // backend, one 8090/8091 port pair, and one active-session reservation per user, so the suite stays
  // serial no matter how many projects it holds.
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  webServer: [
    {
      command: FRESH_BACKEND,
      cwd: REPO_ROOT,
      // The backend also enables the dev-only local-folder submission source so submission.spec can
      // drive the real validate-and-build pipeline from a checked-in fixture, with no network.
      // Which data dir this run owns. The backend wipes whichever one it is launched with, so the
      // default is the throwaway: a run has to say it is complete before it can touch the database
      // `npm run demo` serves. Only `scripts/ci.py frontend-e2e` with no narrowing flags says so, which
      // means running Playwright directly (any `--project`, any `--grep`, or even the whole suite by
      // hand) can never replace a complete fixture with a partial one.
      env: backendEnv(MAIN_PORT, process.env.E2E_DATA_SUBDIR ?? 'partial', {
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
      name: 'season-fixture',
      testMatch: '**/season-fixture.setup.ts',
      use: MAIN_USE,
    },
    ...GROUPS.map((name) => ({
      name,
      testDir: `./e2e/${name}`,
      dependencies: ['season-fixture'],
      use: MAIN_USE,
    })),
  ],
})
