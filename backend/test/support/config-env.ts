import { loadEnvironmentFiles } from '../../src/config/env-files.js'

/** Merge explicit test overrides over the tracked defaults without reading a developer's `.env`. */
export function withDefaultEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return loadEnvironmentFiles({ env: { ...overrides }, includeLocal: false })
}
