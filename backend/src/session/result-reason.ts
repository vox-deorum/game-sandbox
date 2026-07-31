/**
 * The container `result` envelope reasons that map directly to a stored {@link TerminationReason}.
 *
 * These are the endings a sandbox reports for itself from inside the run; the orchestrator-side
 * outcomes (a client stop turned crash, the idle window, the wall-clock backstop, a quota kill, or a
 * bare crash) are decided outside this set when a session or run finalizes. Shared by the live-session
 * relay (which stamps the producing session's reason) and the workflow runner (which stamps an
 * automated recording's reason, since an automated run has no session to carry it).
 */
import type { TerminationReason } from '../storage/schema.js'

/** The container-reported reasons that are valid {@link TerminationReason}s as-is. */
export const RESULT_REASONS: ReadonlySet<string> = new Set([
  'terminated',
  'truncated',
  'episode_limit',
  'stopped',
])

/**
 * Coerce a container-reported result reason to a {@link TerminationReason}, or `null` when it is
 * absent or not a recognized result reason. A `null` means no reason we trust: the live relay keeps
 * the session's prior reason, and the workflow runner faults a clean exit that reported no recognized
 * reason rather than inventing one.
 */
export function coerceResultReason(reason: unknown): TerminationReason | null {
  return typeof reason === 'string' && RESULT_REASONS.has(reason)
    ? (reason as TerminationReason)
    : null
}
