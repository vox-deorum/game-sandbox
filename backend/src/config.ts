/**
 * Environment-variable configuration, parsed once into a single typed, validated object.
 *
 * Every consumer receives {@link Config} (or a slice of it) as a constructor argument;
 * module-level config reads are banned, so a test can assemble a whole backend with custom
 * settings. Repository-root `.env.default` and `.env` files feed the same environment boundary;
 * there is no separate config-file schema or secrets manager.
 */
import { isAbsolute, join, resolve } from 'node:path'
import type { TiktokenEncoding } from 'tiktoken'
import { z } from 'zod'

import { loadEnvironmentFiles, REPO_ROOT } from './env-files.js'
import {
  type LlmLimits,
  type LlmModelConfig,
  MAX_LLM_COST_WEIGHT,
  type ModelAlias,
} from './llm/types.js'

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

/** The GitHub OAuth app credentials; present only when both halves are configured. */
export interface AuthGithubOptions {
  clientId: string
  clientSecret: string
}

/**
 * Authentication settings for the embedded Better Auth server (Stage 12). Parsed once in
 * {@link loadConfig} and handed to the auth constructor and the admin seed. A normal startup
 * requires an explicit public origin, signing secret, and bootstrap credentials; the published
 * development values are accepted only behind the explicit `AUTH_ALLOW_INSECURE_DEFAULTS` opt-in on
 * a loopback origin, which also binds the listener to loopback (see {@link Config.listenHost}).
 */
export interface AuthOptions {
  /** The Better Auth signing secret for cookies and tokens. */
  secret: string
  /** The public origin the site is reached at; cookie origin checks and the OAuth callback use it. */
  publicOrigin: string
  /** Origins Better Auth trusts, built from `publicOrigin` plus configured (and dev) extras. */
  trustedOrigins: string[]
  /** Whether the published development defaults were explicitly opted into on a loopback origin. */
  insecureDevelopment: boolean
  /** The bootstrap admin's email, re-synced on every boot. Stored lowercased. */
  adminEmail: string
  /** The bootstrap admin's password, re-synced on every boot. */
  adminPassword: string
  /** The bootstrap admin's display name. */
  adminName: string
  /** GitHub OAuth credentials, or `undefined` when the deployment configures no OAuth app. */
  github?: AuthGithubOptions
}

/** Deployment wiring and default limits for the optional internal LLM proxy. */
export interface LlmOptions {
  internalPort: number
  upstreamUrl?: string
  upstreamKey?: string
  models: Partial<Record<ModelAlias, LlmModelConfig>>
  upstreamTimeoutMs: number
  upstreamMaxRetries: number
  upstreamRetryIntervalMs: number
  tiktokenEncoding: TiktokenEncoding
  defaultMaxOutputTokens: number
  maxOutputTokens: number
  meterRecoveryIntervalMs: number
  sessionLimits: LlmLimits
  developmentLimits: LlmLimits
}

/**
 * The published development-only credentials, exported so `main.ts` can warn when they are in effect
 * and the config tests can assert they are refused in a normal (non-insecure) startup. They are
 * public and deliberately weak; never deploy with them.
 */
export const DEV_AUTH_SECRET = 'dev-secret-do-not-deploy-32-chars'
export const DEV_ADMIN_EMAIL = 'admin@example.com'
export const DEV_ADMIN_PASSWORD = 'admin-dev-password'

export interface Config {
  /** TCP port the HTTP/WebSocket server listens on. */
  port: number
  /**
   * The interface the HTTP/WebSocket server binds to. `0.0.0.0` for a normal startup; the loopback
   * interface behind `PUBLIC_ORIGIN` (`127.0.0.1` or `::1`) when insecure development defaults are
   * explicitly enabled, so an accidental insecure deployment cannot be reached off-host.
   */
  listenHost: string
  /**
   * The site's display name, used for branding (page titles, the sidebar brand, and anywhere the
   * deployment identifies itself). Defaults to `Game Sandbox`; override with `SITE_NAME`.
   */
  siteName: string
  /**
   * A compact brand for space-sensitive or space-hostile contexts — the mobile bar, and anywhere a
   * name with spaces is awkward. Defaults to {@link Config.siteName} (so it is `Game Sandbox` out of
   * the box, and mirrors a customized `SITE_NAME` unless overridden); set `SITE_SHORT_NAME` for a
   * distinct short form.
   */
  siteShortName: string
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
  /**
   * The documentation root the backend reads shared in-app student guides from at runtime. The
   * default resolves to the repo's `docs/` regardless of the process working directory (the backend
   * already runs from the checkout, the same assumption `frontendDir` makes). Override with
   * `DOCS_DIR` only when a deployment relocates the shared tree. Canonical environment guides remain
   * under the checkout's `environments/` directory and are exposed through virtual student paths.
   */
  docsDir: string
  /**
   * An optional class-specific markdown file that replaces the documentation landing page. When set,
   * `GET /api/docs/index` serves this file instead of `docs/students/index.md`, so a deployment can put
   * its own course home (schedule, links, grading) at `/docs` without editing the shared guides. A path
   * to a single markdown file; unset means the default landing. Read from `DOCS_INDEX_FILE`.
   */
  docsIndexFile?: string
  sandbox: SandboxDefaults
  executionDriver: ExecutionDriverKind
  docker: DockerDriverOptions
  submission: SubmissionOptions
  auth: AuthOptions
  llm: LlmOptions
}

class ConfigError extends Error {}

/**
 * Environment variables arrive as strings; these helpers wrap small zod schemas so every typed
 * value passes through the one validation library the backend standardizes on. Concrete defaults
 * belong in `.env.default`, so required helpers reject an unset or empty value before validating it.
 * Zod failures become a {@link ConfigError} naming the offending variable.
 */

/** Non-negative integer (`Number()`-coerced); rejects floats, NaN, and negatives. */
const NON_NEGATIVE_INT = z.coerce.number().int().nonnegative()
/** Positive integer (`Number()`-coerced); used where zero cannot represent a usable limit. */
const POSITIVE_INT = z.coerce.number().int().positive()
/** Positive, finite number; floats allowed (e.g. fractional CPU shares). */
const POSITIVE_NUMBER = z.coerce.number().positive().finite()
/** The documented boolean spellings, normalized lower-case; anything else throws. */
const ENV_BOOL = z.stringbool({ truthy: ['true', '1', 'yes'], falsy: ['false', '0', 'no'] })

function requiredStringVar(env: NodeJS.ProcessEnv, name: string): string {
  const raw = env[name]
  if (raw === undefined || raw === '') {
    throw new ConfigError(`${name} is required in .env.default or the process environment`)
  }
  return raw
}

function optionalStringVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]
  return raw !== undefined && raw !== '' ? raw : undefined
}

function intVar(env: NodeJS.ProcessEnv, name: string): number {
  const raw = requiredStringVar(env, name)
  const result = NON_NEGATIVE_INT.safeParse(raw)
  if (!result.success) {
    throw new ConfigError(`${name} must be a non-negative integer, got ${raw}`)
  }
  return result.data
}

function positiveIntVar(env: NodeJS.ProcessEnv, name: string): number {
  const raw = requiredStringVar(env, name)
  const result = POSITIVE_INT.safeParse(raw)
  if (!result.success) {
    throw new ConfigError(`${name} must be a positive integer, got ${raw}`)
  }
  return result.data
}

/** An integer setting with operational lower and upper bounds beyond basic non-negativity. */
function boundedIntVar(
  env: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const value = intVar(env, name)
  if (value < minimum || value > maximum) {
    throw new ConfigError(`${name} must be between ${minimum} and ${maximum}, got ${value}`)
  }
  return value
}

function listVar(env: NodeJS.ProcessEnv, name: string): string[] {
  const raw = env[name]
  if (raw === undefined) {
    return []
  }
  const items = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
  return items
}

function boolVar(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = requiredStringVar(env, name)
  const result = ENV_BOOL.safeParse(raw.trim().toLowerCase())
  if (!result.success) {
    throw new ConfigError(`${name} must be a boolean (true/false), got ${raw}`)
  }
  return result.data
}

function numberVar(env: NodeJS.ProcessEnv, name: string): number {
  const raw = requiredStringVar(env, name)
  const result = POSITIVE_NUMBER.safeParse(raw)
  if (!result.success) {
    throw new ConfigError(`${name} must be a positive number, got ${raw}`)
  }
  return result.data
}

function cappedPositiveNumberVar(env: NodeJS.ProcessEnv, name: string, maximum: number): number {
  const value = numberVar(env, name)
  if (value > maximum) {
    throw new ConfigError(`${name} must be no greater than ${maximum}, got ${value}`)
  }
  return value
}

function repoPathVar(env: NodeJS.ProcessEnv, name: string): string {
  const raw = requiredStringVar(env, name)
  return isAbsolute(raw) ? raw : resolve(REPO_ROOT, raw)
}

function optionalRepoPathVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = optionalStringVar(env, name)
  return raw === undefined || isAbsolute(raw) ? raw : resolve(REPO_ROOT, raw)
}

/** Optional absolute HTTP(S) endpoint, retaining its configured path for compatible `/v1` bases. */
function httpUrlVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = optionalStringVar(env, name)
  if (raw === undefined) return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ConfigError(`${name} must be a valid absolute http(s) URL`)
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    raw !== raw.trim() ||
    url.username !== '' ||
    url.password !== '' ||
    raw.includes('?') ||
    raw.includes('#') ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    // Never echo the configured value because a malformed URL may itself contain a credential.
    throw new ConfigError(`${name} must be a valid absolute http(s) URL`)
  }
  return raw
}

/** The loopback hostnames a `PUBLIC_ORIGIN` may use under the insecure-defaults opt-in. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Parse a public origin: a valid absolute `http(s)` URL with no path, query, or fragment. We reject
 * anything else here rather than let `.origin` paper over it — a non-`http(s)` scheme yields the
 * string `"null"` as its origin, and a URL with a path (`https://host/sandbox`) silently drops the
 * path — both of which would then flow undetected into Better Auth's `baseURL`/`trustedOrigins`.
 */
function parseOrigin(name: string, raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ConfigError(`${name} must be a valid absolute URL, got ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${name} must be an http(s) URL, got ${raw}`)
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new ConfigError(
      `${name} must be a bare origin with no path, query, or fragment, got ${raw}`,
    )
  }
  return url
}

/** Require a deployment-supplied value that is present and not the published development value. */
function requireDeployedValue(name: string, raw: string | undefined, devValue: string): string {
  if (raw === undefined || raw === '') {
    throw new ConfigError(
      `${name} is required (or set AUTH_ALLOW_INSECURE_DEFAULTS=true for a loopback development setup)`,
    )
  }
  if (raw === devValue) {
    throw new ConfigError(
      `${name} is set to the published development value; set a real value, or set AUTH_ALLOW_INSECURE_DEFAULTS=true for a loopback development setup`,
    )
  }
  return raw
}

/**
 * Parse the Docker driver options. Extracted from {@link loadConfig} so `build-image.ts` can build
 * a driver from the environment without also requiring the auth variables a full {@link Config} does.
 */
export function loadDockerOptions(env?: NodeJS.ProcessEnv): DockerDriverOptions {
  env ??= loadEnvironmentFiles()
  const imagePolicyResult = z
    .enum(['reuse', 'rebuild'])
    .safeParse(requiredStringVar(env, 'DOCKER_IMAGE_POLICY'))
  if (!imagePolicyResult.success) {
    throw new ConfigError(
      `DOCKER_IMAGE_POLICY must be 'reuse' or 'rebuild', got ${env.DOCKER_IMAGE_POLICY}`,
    )
  }
  return {
    imageTagPrefix: requiredStringVar(env, 'DOCKER_IMAGE_TAG_PREFIX'),
    imagePolicy: imagePolicyResult.data,
    overlayBuildTimeoutMs: intVar(env, 'SUBMISSION_BUILD_TIMEOUT_MS'),
  }
}

/**
 * Parse the {@link AuthOptions} and the derived {@link Config.listenHost}. A normal startup requires
 * an explicit public origin, secret, and bootstrap credentials, and binds `0.0.0.0`. The published
 * development defaults are accepted only when `AUTH_ALLOW_INSECURE_DEFAULTS=true` **and**
 * `PUBLIC_ORIGIN` is loopback; that mode binds the matching loopback interface instead.
 */
function loadAuthOptions(env: NodeJS.ProcessEnv): { auth: AuthOptions; listenHost: string } {
  const insecure = boolVar(env, 'AUTH_ALLOW_INSECURE_DEFAULTS')

  // GitHub OAuth is both-or-neither: one half without the other is a misconfiguration, not a partial
  // capability. These are distinct from GITHUB_TOKEN, which stays a submissions-only credential.
  const githubId = optionalStringVar(env, 'GITHUB_OAUTH_CLIENT_ID')
  const githubSecret = optionalStringVar(env, 'GITHUB_OAUTH_CLIENT_SECRET')
  if ((githubId === undefined) !== (githubSecret === undefined)) {
    throw new ConfigError(
      'GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET must both be set or both be unset',
    )
  }
  const github =
    githubId !== undefined && githubSecret !== undefined
      ? { clientId: githubId, clientSecret: githubSecret }
      : undefined

  const adminName = requiredStringVar(env, 'ADMIN_NAME')
  const extraOrigins = listVar(env, 'AUTH_TRUSTED_ORIGINS')
  const rawOrigin = requiredStringVar(env, 'PUBLIC_ORIGIN')

  let publicOrigin: string
  let listenHost: string
  let secret: string
  let adminEmail: string
  let adminPassword: string
  // Trusted origins added only in the loopback opt-in, on top of the public origin and the
  // configured extras (see the trustedOrigins assembly below).
  let devTrustedOrigins: string[] = []

  if (insecure) {
    // Loopback-only: the opt-in defaults the origin to localhost and refuses any non-loopback origin,
    // and the listener binds the corresponding loopback interface so published credentials can never
    // answer off-host.
    const originUrl = parseOrigin('PUBLIC_ORIGIN', rawOrigin)
    if (!LOOPBACK_HOSTNAMES.has(originUrl.hostname)) {
      throw new ConfigError(
        `AUTH_ALLOW_INSECURE_DEFAULTS requires a loopback PUBLIC_ORIGIN (localhost, 127.0.0.1, or [::1]), got ${originUrl.hostname}`,
      )
    }
    publicOrigin = originUrl.origin
    // URL keeps IPv6 hosts bracketed ("[::1]"); Node's listener wants the bare address ("::1").
    listenHost = originUrl.hostname === '[::1]' ? '::1' : '127.0.0.1'
    secret = requiredStringVar(env, 'AUTH_SECRET')
    adminEmail = requiredStringVar(env, 'ADMIN_EMAIL').toLowerCase()
    adminPassword = requiredStringVar(env, 'ADMIN_PASSWORD')
    // Better Auth matches the request's `Origin` header against trustedOrigins exactly, so trusting
    // only the `localhost` spelling rejects a sign-in reached at the equivalent `127.0.0.1`/`[::1]`
    // loopback (a common Windows fallback when `localhost` resolves to a stack the listener is not on)
    // with "Invalid origin". All loopback hosts are the same local machine in this opt-in dev mode, so
    // trust every spelling of the public origin's port, plus the Vite dev-server origin.
    const suffix = originUrl.port === '' ? '' : `:${originUrl.port}`
    const loopbackOrigins = [...LOOPBACK_HOSTNAMES].map(
      (h) => `${originUrl.protocol}//${h}${suffix}`,
    )
    devTrustedOrigins = [...loopbackOrigins, 'http://localhost:5173']
  } else {
    publicOrigin = parseOrigin('PUBLIC_ORIGIN', rawOrigin).origin
    listenHost = '0.0.0.0'
    secret = requireDeployedValue('AUTH_SECRET', env.AUTH_SECRET, DEV_AUTH_SECRET)
    // Normalize before the published-value guard so a differently-cased ADMIN_EMAIL cannot slip past
    // it and then lowercase down to the known-public dev address.
    adminEmail = requireDeployedValue(
      'ADMIN_EMAIL',
      env.ADMIN_EMAIL?.toLowerCase(),
      DEV_ADMIN_EMAIL,
    )
    adminPassword = requireDeployedValue('ADMIN_PASSWORD', env.ADMIN_PASSWORD, DEV_ADMIN_PASSWORD)
  }

  // Better Auth signs every session cookie with this secret and only warns (never refuses) on a weak
  // one, so enforce the recommended floor here where every other misconfiguration already fails fast.
  if (secret.length < 32) {
    throw new ConfigError('AUTH_SECRET must be at least 32 characters')
  }

  // The loopback and Vite dev origins are trusted only in the opted-in local mode (devTrustedOrigins
  // is empty otherwise); the list is the public origin plus those plus the configured extras. De-duped
  // so a repeated origin (e.g. the public origin, which is itself one of the loopback spellings) is not
  // sent twice.
  const trustedOrigins = [...new Set([publicOrigin, ...devTrustedOrigins, ...extraOrigins])]

  return {
    auth: {
      secret,
      publicOrigin,
      trustedOrigins,
      insecureDevelopment: insecure,
      adminEmail,
      adminPassword,
      adminName,
      github,
    },
    listenHost,
  }
}

/**
 * Build a {@link Config} from a complete environment and validate every tracked default or override.
 *
 * With no explicit `env`, the required `.env.default`, optional `.env`, and `process.env` are merged.
 * Tests pass a complete explicit map and skip file loading so a developer's `.env` cannot affect them.
 */
export function loadConfig(env?: NodeJS.ProcessEnv): Config {
  // Explicit maps are complete configuration inputs. Only the process-backed path reads files,
  // preserving dependency injection and deterministic unit tests.
  env ??= loadEnvironmentFiles()
  const port = intVar(env, 'PORT')
  const dataDir = repoPathVar(env, 'DATA_DIR')

  const driverResult = z.enum(['docker']).safeParse(requiredStringVar(env, 'EXECUTION_DRIVER'))
  if (!driverResult.success) {
    throw new ConfigError(
      `EXECUTION_DRIVER must be 'docker' (the only driver in this stage), got ${env.EXECUTION_DRIVER}`,
    )
  }

  const { auth, listenHost } = loadAuthOptions(env)

  // The short name falls back to the resolved site name (not the raw default), so a deployment that
  // sets only SITE_NAME gets a matching short form for free while either can be overridden alone.
  const siteName = requiredStringVar(env, 'SITE_NAME')
  const siteShortName = optionalStringVar(env, 'SITE_SHORT_NAME') ?? siteName

  const defaultMaxOutputTokens = boundedIntVar(env, 'LLM_DEFAULT_MAX_OUTPUT_TOKENS', 0, 1_000_000)
  const maxOutputTokens = boundedIntVar(env, 'LLM_MAX_OUTPUT_TOKENS', 1, 1_000_000)
  if (defaultMaxOutputTokens > maxOutputTokens) {
    throw new ConfigError('LLM_DEFAULT_MAX_OUTPUT_TOKENS must not exceed LLM_MAX_OUTPUT_TOKENS')
  }

  const models: Partial<Record<ModelAlias, LlmModelConfig>> = {}
  const largeModel = optionalStringVar(env, 'LLM_MODEL_LARGE')
  const mediumModel = optionalStringVar(env, 'LLM_MODEL_MEDIUM')
  const smallModel = optionalStringVar(env, 'LLM_MODEL_SMALL')
  const largeCostWeight = cappedPositiveNumberVar(env, 'LLM_COST_WEIGHT_LARGE', MAX_LLM_COST_WEIGHT)
  const mediumCostWeight = cappedPositiveNumberVar(
    env,
    'LLM_COST_WEIGHT_MEDIUM',
    MAX_LLM_COST_WEIGHT,
  )
  const smallCostWeight = cappedPositiveNumberVar(env, 'LLM_COST_WEIGHT_SMALL', MAX_LLM_COST_WEIGHT)
  if (largeModel !== undefined) {
    models.large = { upstream: largeModel, costWeight: largeCostWeight }
  }
  if (mediumModel !== undefined) {
    models.medium = { upstream: mediumModel, costWeight: mediumCostWeight }
  }
  if (smallModel !== undefined) {
    models.small = { upstream: smallModel, costWeight: smallCostWeight }
  }

  const tiktokenEncoding = z
    .enum(['gpt2', 'r50k_base', 'p50k_base', 'p50k_edit', 'cl100k_base', 'o200k_base'])
    .safeParse(requiredStringVar(env, 'LLM_TIKTOKEN_ENCODING'))
  if (!tiktokenEncoding.success) {
    throw new ConfigError(
      `LLM_TIKTOKEN_ENCODING is not supported, got ${env.LLM_TIKTOKEN_ENCODING}`,
    )
  }

  return {
    port,
    listenHost,
    siteName,
    siteShortName,
    dataDir,
    dbPath: join(dataDir, 'sandbox.db'),
    recordingsDir: join(dataDir, 'recordings'),
    submissionsDir: join(dataDir, 'submissions'),
    sessionIdleTimeoutMs: intVar(env, 'SESSION_IDLE_TIMEOUT_MS'),
    sessionMaxDurationMs: intVar(env, 'SESSION_MAX_DURATION_MS'),
    recordingRetentionDays: intVar(env, 'RECORDING_RETENTION_DAYS'),
    recordingUserQuota: intVar(env, 'RECORDING_USER_QUOTA'),
    recordingSweepIntervalMs: intVar(env, 'RECORDING_SWEEP_INTERVAL_MS'),
    overlayImageBudget: intVar(env, 'OVERLAY_IMAGE_BUDGET'),
    overlayImageSweepIntervalMs: intVar(env, 'OVERLAY_IMAGE_SWEEP_INTERVAL_MS'),
    frontendDir: repoPathVar(env, 'FRONTEND_DIST'),
    docsDir: repoPathVar(env, 'DOCS_DIR'),
    docsIndexFile: optionalRepoPathVar(env, 'DOCS_INDEX_FILE'),
    sandbox: {
      cpus: numberVar(env, 'SANDBOX_CPUS'),
      memoryMb: intVar(env, 'SANDBOX_MEMORY_MB'),
      scratchMb: intVar(env, 'SANDBOX_SCRATCH_MB'),
    },
    executionDriver: 'docker',
    docker: loadDockerOptions(env),
    submission: {
      githubToken: optionalStringVar(env, 'GITHUB_TOKEN'),
      allowLocalSubmissions: boolVar(env, 'ALLOW_LOCAL_SUBMISSIONS'),
      gitTimeoutMs: intVar(env, 'SUBMISSION_GIT_TIMEOUT_MS'),
      loadCheckTimeoutMs: intVar(env, 'SUBMISSION_LOAD_CHECK_TIMEOUT_MS'),
      submissionMaxSizeBytes: intVar(env, 'SUBMISSION_MAX_SIZE_MB') * 1024 * 1024,
    },
    auth,
    llm: {
      internalPort: boundedIntVar(env, 'LLM_INTERNAL_PORT', 1, 65_535),
      upstreamUrl: httpUrlVar(env, 'LLM_UPSTREAM_URL'),
      upstreamKey: optionalStringVar(env, 'LLM_UPSTREAM_KEY'),
      models,
      upstreamTimeoutMs: boundedIntVar(env, 'LLM_UPSTREAM_TIMEOUT_MS', 1, 600_000),
      upstreamMaxRetries: boundedIntVar(env, 'LLM_UPSTREAM_MAX_RETRIES', 0, 10),
      upstreamRetryIntervalMs: boundedIntVar(env, 'LLM_UPSTREAM_RETRY_INTERVAL_MS', 1, 60_000),
      tiktokenEncoding: tiktokenEncoding.data,
      defaultMaxOutputTokens,
      maxOutputTokens,
      meterRecoveryIntervalMs: boundedIntVar(env, 'LLM_METER_RECOVERY_INTERVAL_MS', 1, 3_600_000),
      sessionLimits: {
        tokenBudget: positiveIntVar(env, 'LLM_SESSION_TOKEN_BUDGET'),
        requestsPerMinute: positiveIntVar(env, 'LLM_SESSION_RATE_LIMIT_RPM'),
      },
      developmentLimits: {
        tokenBudget: positiveIntVar(env, 'LLM_DEVELOPMENT_TOKEN_BUDGET'),
        requestsPerMinute: positiveIntVar(env, 'LLM_DEVELOPMENT_RATE_LIMIT_RPM'),
      },
    },
  }
}
