/** Platform time reserved for container startup, transitions, recording, and teardown. */
export const SESSION_OVERHEAD_ALLOWANCE_MS = 60_000
/** Fixed fallback for unpaced games when no deployment-wide duration override is configured. */
export const UNPACED_SESSION_MAX_DURATION_MS = 600_000

/** Resolve the live-session wall-clock ceiling from deployment, environment, and resolved season rules. */
export function resolveSessionMaxDurationMs({
  overrideMs,
  paceIntervalMs,
  recommendedEpisodeTicks,
  agentPlayerCount,
  episodeTimeoutMs,
}: {
  overrideMs: number | null
  paceIntervalMs: number | null
  recommendedEpisodeTicks: number
  agentPlayerCount: number
  episodeTimeoutMs: number
}): number {
  if (overrideMs !== null) {
    return overrideMs
  }
  if (paceIntervalMs !== null && paceIntervalMs > 0) {
    return (
      recommendedEpisodeTicks * paceIntervalMs +
      agentPlayerCount * episodeTimeoutMs +
      SESSION_OVERHEAD_ALLOWANCE_MS
    )
  }
  return UNPACED_SESSION_MAX_DURATION_MS
}
