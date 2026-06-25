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

import { z } from 'zod'

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
  /** Wall-clock ceiling on one overlay build, so a hung build cannot stall the validation worker. */
  overlayBuildTimeoutMs: number
}

/**
 * Submission source-resolution settings, consumed by `submission/source/` (Stage 5.2). The token is
 * the only secret here; it is used to authenticate GitHub reachability checks and back private-repo
 * clone/fetch credentials, and is never stored on a submission row or logged.
 */
export interface SubmissionOptions {
  /** Optional GitHub token for private-repo auth and authenticated reachability; public repos need none. */
  githubToken?: string
  /**
   * Whether the dev-only local-folder source is constructed and offered. Off by default; the gate,
   * not path-sanitization, is the security boundary, so this must stay off in real deployments.
   */
  allowLocalSubmissions: boolean
  /** Wall-clock ceiling on each `git` invocation, so an unreachable repo fails fast rather than hanging. */
  gitTimeoutMs: number
  /**
   * Wall-clock ceiling on one sandboxed load check (Stage 5.4). Import-and-construct should be
   * near-instant, so a hang is itself a failure; kept short but clear of a cold container start.
   */
  loadCheckTimeoutMs: number
  /**
   * The site-default cap, in bytes, on a submission's checked-out source tree (excluding `.git` and
   * the other ignored segments). Enforced in the static stage; a per-season `submission_max_size_mb`
   * override takes precedence when set. Read from `SUBMISSION_MAX_SIZE_MB` (MB; stored as bytes).
   * A value of `0` means no tree can pass, not "unlimited".
   */
  submissionMaxSizeBytes: number
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
  /** Submission-snapshot root: one `<id>.tar.gz` per accepted submission, under {@link Config.dataDir}. */
  submissionsDir: string
  /** Idle window before a session with no attached socket (or no human input) is killed. */
  sessionIdleTimeoutMs: number
  /** Wall-clock backstop catching a hung container that in-container budgets cannot. */
  sessionMaxDurationMs: number
  /**
   * The operator-configured allowlist of user ids that may start live sessions. Keyed on the
   * Stage 3 identity stub until OAuth brings real handles; everything read-only stays open.
   */
  sessionAllowlist: string[]
  /**
   * The operator allowlist of user ids that may reach the Stage 6 admin console and API (declaring
   * seasons, configuring them, opening/closing the gates, triggering runs). Read from
   * `OPERATOR_ALLOWLIST`, defaulting to `[DEV_USER_ID]` exactly as {@link Config.sessionAllowlist}
   * does, so the console works out of the box in dev; `isOperator` is the single predicate over it.
   */
  operatorAllowlist: string[]
  /** Retention window in days: an unpinned recording older than this is swept. */
  recordingRetentionDays: number
  /** Per-user recording quota; oldest-unpinned-first eviction brings a user back within it. */
  recordingUserQuota: number
  /** How often the eviction sweep runs on its own timer (it also runs at startup and on finalize). */
  recordingSweepIntervalMs: number
  /**
   * Max overlay images retained by the Stage 5.4 eviction sweep. Active-`ready` submissions' images
   * are always kept and count toward this budget (they are never evicted, like pinned recordings);
   * the rest are trimmed newest-kept, oldest-first.
   */
  overlayImageBudget: number
  /** How often the overlay-image sweep runs (it also runs at startup and after each overlay build). */
  overlayImageSweepIntervalMs: number
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
  submission: SubmissionOptions
}

class ConfigError extends Error {}

/**
 * Environment variables arrive as strings; these helpers wrap small zod schemas so every typed
 * value passes through the one validation library the backend standardizes on. Each helper applies
 * the unset/empty fallback first, then validates the present string, rethrowing a zod failure as a
 * {@link ConfigError} naming the offending variable (the message the operator and the tests read).
 */

/** Non-negative integer (`Number()`-coerced); rejects floats, NaN, and negatives. */
const NON_NEGATIVE_INT = z.coerce.number().int().nonnegative()
/** Positive, finite number; floats allowed (e.g. fractional CPU shares). */
const POSITIVE_NUMBER = z.coerce.number().positive().finite()
/** The documented boolean spellings, normalized lower-case; anything else throws. */
const ENV_BOOL = z.stringbool({ truthy: ['true', '1', 'yes'], falsy: ['false', '0', 'no'] })

function intVar(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') {
    return fallback
  }
  const result = NON_NEGATIVE_INT.safeParse(raw)
  if (!result.success) {
    throw new ConfigError(`${name} must be a non-negative integer, got ${raw}`)
  }
  return result.data
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

function boolVar(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]
  if (raw === undefined || raw === '') {
    return fallback
  }
  const result = ENV_BOOL.safeParse(raw.trim().toLowerCase())
  if (!result.success) {
    throw new ConfigError(`${name} must be a boolean (true/false), got ${raw}`)
  }
  return result.data
}

function numberVar(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') {
    return fallback
  }
  const result = POSITIVE_NUMBER.safeParse(raw)
  if (!result.success) {
    throw new ConfigError(`${name} must be a positive number, got ${raw}`)
  }
  return result.data
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

  const driverResult = z.enum(['docker']).safeParse(env.EXECUTION_DRIVER ?? 'docker')
  if (!driverResult.success) {
    throw new ConfigError(
      `EXECUTION_DRIVER must be 'docker' (the only driver in this stage), got ${env.EXECUTION_DRIVER}`,
    )
  }

  const imagePolicyResult = z
    .enum(['reuse', 'rebuild'])
    .safeParse(env.DOCKER_IMAGE_POLICY ?? 'reuse')
  if (!imagePolicyResult.success) {
    throw new ConfigError(
      `DOCKER_IMAGE_POLICY must be 'reuse' or 'rebuild', got ${env.DOCKER_IMAGE_POLICY}`,
    )
  }
  const imagePolicy = imagePolicyResult.data

  return {
    port,
    dataDir,
    dbPath: join(dataDir, 'sandbox.db'),
    recordingsDir: join(dataDir, 'recordings'),
    submissionsDir: join(dataDir, 'submissions'),
    sessionIdleTimeoutMs: intVar(env, 'SESSION_IDLE_TIMEOUT_MS', 60_000),
    sessionMaxDurationMs: intVar(env, 'SESSION_MAX_DURATION_MS', 600_000),
    sessionAllowlist: listVar(env, 'SESSION_ALLOWLIST', [DEV_USER_ID]),
    operatorAllowlist: listVar(env, 'OPERATOR_ALLOWLIST', [DEV_USER_ID]),
    recordingRetentionDays: intVar(env, 'RECORDING_RETENTION_DAYS', 30),
    recordingUserQuota: intVar(env, 'RECORDING_USER_QUOTA', 100),
    recordingSweepIntervalMs: intVar(env, 'RECORDING_SWEEP_INTERVAL_MS', 3_600_000),
    overlayImageBudget: intVar(env, 'OVERLAY_IMAGE_BUDGET', 50),
    overlayImageSweepIntervalMs: intVar(env, 'OVERLAY_IMAGE_SWEEP_INTERVAL_MS', 3_600_000),
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
      overlayBuildTimeoutMs: intVar(env, 'SUBMISSION_BUILD_TIMEOUT_MS', 120_000),
    },
    submission: {
      githubToken: env.GITHUB_TOKEN && env.GITHUB_TOKEN !== '' ? env.GITHUB_TOKEN : undefined,
      allowLocalSubmissions: boolVar(env, 'ALLOW_LOCAL_SUBMISSIONS', false),
      gitTimeoutMs: intVar(env, 'SUBMISSION_GIT_TIMEOUT_MS', 15_000),
      loadCheckTimeoutMs: intVar(env, 'SUBMISSION_LOAD_CHECK_TIMEOUT_MS', 30_000),
      submissionMaxSizeBytes: intVar(env, 'SUBMISSION_MAX_SIZE_MB', 25) * 1024 * 1024,
    },
  }
}
