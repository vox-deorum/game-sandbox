/**
 * Environment-variable configuration, parsed once into a single typed, validated object.
 *
 * Every consumer receives {@link Config} (or a slice of it) as a constructor argument;
 * module-level config reads are banned, so a test can assemble a whole backend with custom
 * settings. There are no config files and no secrets manager in this stage; OAuth secrets
 * arrive in Stage 4 when they exist.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEV_USER_ID } from './identity.js'

// The repo root sits two levels above backend/src, so the default frontend bundle path resolves the
// same regardless of the process's working directory (started from the repo root or from backend/).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The only execution driver that exists in this stage. */
export type ExecutionDriverKind = 'docker'

/** Whether the driver reuses an existing image tag or always rebuilds. */
export type ImagePolicy = 'reuse' | 'rebuild'

/** The driver-neutral sandbox quotas applied to every session container. */
export interface SandboxDefaults {
  cpus: number
  memoryMb: number
  scratchMb: number
}

/** Options specific to the local Docker driver. */
export interface DockerDriverOptions {
  imageTagPrefix: string
  imagePolicy: ImagePolicy
}

export interface Config {
  /** TCP port the HTTP/WebSocket server listens on. */
  port: number
  /** Root directory holding the SQLite database and the recordings volume. */
  dataDir: string
  /** Absolute path to the SQLite database file inside {@link Config.dataDir}. */
  dbPath: string
  /** Recordings root, mounted into session containers and listed by the recordings API. */
  recordingsDir: string
  /** Idle window before a session with no attached socket (or no human input) is killed. */
  sessionIdleTimeoutMs: number
  /** Wall-clock backstop catching a hung container that in-container budgets cannot. */
  sessionMaxDurationMs: number
  /**
   * The operator-configured allowlist of user ids that may start live sessions. Keyed on the
   * Stage 3 identity stub until OAuth brings real handles; everything read-only stays open.
   */
  sessionAllowlist: string[]
  /** Retention window in days: an unpinned recording older than this is swept. */
  recordingRetentionDays: number
  /** Per-user recording quota; oldest-unpinned-first eviction brings a user back within it. */
  recordingUserQuota: number
  /** How often the eviction sweep runs on its own timer (it also runs at startup and on finalize). */
  recordingSweepIntervalMs: number
  /**
   * The built frontend bundle the backend serves at the root in production, so one process and one
   * command launch the whole stack. Vite serves the app in development (and proxies `/api` here), and
   * the tests never build a bundle, so this is omitted in both — serving is wired only when the
   * directory is present. Defaults to `frontend/dist`; override with `FRONTEND_DIST`.
   */
  frontendDir?: string
  sandbox: SandboxDefaults
  executionDriver: ExecutionDriverKind
  docker: DockerDriverOptions
}

class ConfigError extends Error {}

function intVar(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') {
    return fallback
  }
  const value = Number(raw)
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new ConfigError(`${name} must be a non-negative integer, got ${raw}`)
  }
  return value
}

function listVar(env: NodeJS.ProcessEnv, name: string, fallback: string[]): string[] {
  const raw = env[name]
  if (raw === undefined) {
    return fallback
  }
  const items = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
  return items
}

function numberVar(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') {
    return fallback
  }
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive number, got ${raw}`)
  }
  return value
}

/**
 * Build a {@link Config} from environment variables with class-scale defaults.
 *
 * The default `env` is `process.env`; tests pass an explicit map. The idle and max-duration
 * windows are deliberately conservative defaults and may be tuned during Stage 4 playtesting.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = intVar(env, 'PORT', 8080)
  const dataDir = env.DATA_DIR && env.DATA_DIR !== '' ? env.DATA_DIR : join(process.cwd(), 'data')

  const driver = env.EXECUTION_DRIVER ?? 'docker'
  if (driver !== 'docker') {
    throw new ConfigError(
      `EXECUTION_DRIVER must be 'docker' (the only driver in this stage), got ${driver}`,
    )
  }

  const imagePolicy = env.DOCKER_IMAGE_POLICY ?? 'reuse'
  if (imagePolicy !== 'reuse' && imagePolicy !== 'rebuild') {
    throw new ConfigError(`DOCKER_IMAGE_POLICY must be 'reuse' or 'rebuild', got ${imagePolicy}`)
  }

  return {
    port,
    dataDir,
    dbPath: join(dataDir, 'sandbox.db'),
    recordingsDir: join(dataDir, 'recordings'),
    sessionIdleTimeoutMs: intVar(env, 'SESSION_IDLE_TIMEOUT_MS', 60_000),
    sessionMaxDurationMs: intVar(env, 'SESSION_MAX_DURATION_MS', 600_000),
    sessionAllowlist: listVar(env, 'SESSION_ALLOWLIST', [DEV_USER_ID]),
    recordingRetentionDays: intVar(env, 'RECORDING_RETENTION_DAYS', 30),
    recordingUserQuota: intVar(env, 'RECORDING_USER_QUOTA', 100),
    recordingSweepIntervalMs: intVar(env, 'RECORDING_SWEEP_INTERVAL_MS', 3_600_000),
    frontendDir:
      env.FRONTEND_DIST && env.FRONTEND_DIST !== ''
        ? env.FRONTEND_DIST
        : join(REPO_ROOT, 'frontend', 'dist'),
    sandbox: {
      cpus: numberVar(env, 'SANDBOX_CPUS', 1),
      memoryMb: intVar(env, 'SANDBOX_MEMORY_MB', 512),
      scratchMb: intVar(env, 'SANDBOX_SCRATCH_MB', 256),
    },
    executionDriver: 'docker',
    docker: {
      imageTagPrefix:
        env.DOCKER_IMAGE_TAG_PREFIX && env.DOCKER_IMAGE_TAG_PREFIX !== ''
          ? env.DOCKER_IMAGE_TAG_PREFIX
          : 'game-sandbox',
      imagePolicy,
    },
  }
}
