/**
 * The single integer schema version this codebase speaks. Kept in its own dependency-free module so
 * the browser can import it (via the `@game-sandbox/schema/version` subpath) to tell a replay it does
 * not understand from one it does — without pulling in the Ajv-backed readers from the barrel, which
 * cannot run in a bundle. The barrel re-exports it for the Node side.
 */

/** Bumps only on a breaking change to the state/header schema; every line must match it. */
export const SCHEMA_VERSION = 1
