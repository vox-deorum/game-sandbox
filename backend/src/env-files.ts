/**
 * Repository-root environment-file loading for backend entry points.
 *
 * The committed `.env.default` is the authoritative default configuration. A gitignored `.env`
 * may override it, while variables already present in the process environment remain authoritative.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

/** The repository root, resolved from source so loading is independent of the process working directory. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

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
 * Load the required `.env.default` followed by the optional `.env`, without replacing supplied
 * variables. An own property with an undefined value still counts as supplied, which lets validation
 * tests deliberately mask a tracked default.
 */
export function loadEnvironmentFiles({
  env = process.env,
  includeLocal = true,
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
