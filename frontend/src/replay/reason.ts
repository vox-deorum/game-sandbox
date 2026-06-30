// The termination reasons that mean a run reached a natural conclusion — a terminal state, or the
// episode ran to its cap — as opposed to being stopped, idled out, time-limited, killed, or crashed.
const COMPLETED_OUTCOMES = new Set(['terminated', 'truncated', 'episode_limit'])

// True when a run finished play, so it warrants final standings. The other endings (stopped, idle,
// time limit, OOM, error) leave a partial board that a leaderboard with medals would misrepresent.
// Mirrors scripts/play.py, which shows the game-over leaderboard for a terminal or step-capped episode
// but not for a quit.
export function isCompletedOutcome(reason: string | null): boolean {
  return reason !== null && COMPLETED_OUTCOMES.has(reason)
}

// A friendly line for a session's termination reason, shared by the live session page (its ended-state
// badge) and the replay viewer (its outcome badge), so a finished run reads the same on both. A paused-
// and-idled session reads as a normal ending, not an error.
export function reasonText(reason: string | null): string {
  switch (reason) {
    case 'terminated':
      return 'Game over'
    case 'truncated':
    case 'episode_limit':
      return 'Episode complete'
    case 'stopped':
      return 'Stopped'
    case 'idle_timeout':
      return 'Ended for inactivity'
    case 'time_limit':
      return 'Reached the time limit'
    case 'oom_killed':
      return 'Ended (out of memory)'
    case 'error':
      return 'Ended unexpectedly'
    default:
      return reason ?? 'Ended'
  }
}
