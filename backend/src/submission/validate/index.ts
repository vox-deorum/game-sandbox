/**
 * The submission validator's public entry point (Stage 5.3–5.4). Step 5's worker depends only on
 * this module for both the static check and the sandboxed load check.
 */
export type {
  Launcher,
  LoadCheckFailure,
  LoadCheckOptions,
  LoadCheckResult,
  LoadCheckSuccess,
} from './load-check.js'
export { runLoadCheck } from './load-check.js'
export type { ParsedManifest, StaticReason, StaticResult } from './static.js'
export { validateStatic } from './static.js'
