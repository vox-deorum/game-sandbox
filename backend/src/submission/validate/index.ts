/**
 * The submission validator's public entry point (Stage 5.3). Step 5's worker depends only on this
 * module for the static check; the sandboxed load check (step 4) lands alongside it later.
 */
export type { ParsedManifest, StaticReason, StaticResult } from './static.js'
export { validateStatic } from './static.js'
