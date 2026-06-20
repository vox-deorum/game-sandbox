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
