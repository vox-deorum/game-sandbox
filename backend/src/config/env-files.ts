/**
 * Repository-root environment-file loading for backend entry points.
 *
 * The committed `.env.default` is the authoritative default configuration. A gitignored `.env`
 * may override it, while variables already present in the process environment remain authoritative.
 * A `LOAD_LOCAL_ENV=false` in the process environment opts out of the machine-local `.env`
 * entirely, so a launcher (the browser e2e suite) can boot a backend immune to a deployment's
 * `.env` left in the tree.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

/** The repository root, resolved from source so loading is independent of the process working directory. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

interface EnvironmentFileOptions {
  /** Environment map to extend. Tests pass an isolated object instead of mutating `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Whether to read the machine-local `.env`; explicit test maps disable it for isolation. */
  includeLocal?: boolean
  /** Root containing `.env.default` and `.env`; overridable for isolated tests. */
  root?: string
}

function readEnvironmentFile(path: string, required: boolean): NodeJS.ProcessEnv {
  if (!required && !existsSync(path)) {
    return {}
  }
  return parseEnv(readFileSync(path, 'utf8'))
}

/**
 * `LOAD_LOCAL_ENV` reads as the documented Boolean, defaulting to on when the process does not
 * supply it. The opt-out comes from the real process environment, before `.env` is loaded, so the
 * file can never turn itself off.
 */
function localEnvEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.LOAD_LOCAL_ENV
  if (raw === undefined || raw === '') {
    return true
  }
  switch (raw.trim().toLowerCase()) {
    case 'false':
    case '0':
    case 'no':
      return false
    case 'true':
    case '1':
    case 'yes':
      return true
    default:
      throw new Error(`LOAD_LOCAL_ENV must be a boolean (true/false), got ${raw}`)
  }
}

/**
 * Load the required `.env.default` followed by the optional `.env`, without replacing supplied
 * variables. An own property with an undefined value still counts as supplied, which lets validation
 * tests deliberately mask a tracked default.
 */
export function loadEnvironmentFiles({
  env = process.env,
  includeLocal = localEnvEnabled(env),
  root = REPO_ROOT,
}: EnvironmentFileOptions = {}): NodeJS.ProcessEnv {
  const fileValues = {
    ...readEnvironmentFile(join(root, '.env.default'), true),
    ...(includeLocal ? readEnvironmentFile(join(root, '.env'), false) : {}),
  }

  for (const [name, value] of Object.entries(fileValues)) {
    if (value !== undefined && !Object.hasOwn(env, name)) {
      env[name] = value
    }
  }
  return env
}
