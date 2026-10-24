import { formatPlayer } from '../lib/format.js'

// The termination reasons that mean a run reached a natural conclusion — a terminal state, or the
// environment's own step cap (`truncated`) — as opposed to being stopped, idled out, killed, crashed,
// or cut off for exhausting its per-episode compute budget (`episode_limit`, a timeout, not a finish).
const COMPLETED_OUTCOMES = new Set(['terminated', 'truncated'])

// True when a run finished play, so it warrants final standings. The other endings (stopped, idle,
// episode/time limit, OOM, error) leave a partial board that a leaderboard with medals would
// misrepresent. Mirrors scripts/play.py, which shows the game-over leaderboard for a terminal or
// step-capped episode but not for a quit or a timeout.
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
      return 'Episode complete'
    case 'episode_limit':
      return 'Timed out'
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

/** Why a run ended with `error`: the player whose agent raised (null when none is to blame) and the
 * harness's one-line description of the exception. */
export interface RunFailure {
  failedPlayer: string | null
  detail: string
}

/** Read a failure from untrusted wire or row fields; null when there is no description to show. */
export function runFailure(failedPlayer: unknown, detail: unknown): RunFailure | null {
  if (typeof detail !== 'string' || detail === '') {
    return null
  }
  return { failedPlayer: typeof failedPlayer === 'string' ? failedPlayer : null, detail }
}

// The line shown under an "Ended unexpectedly" badge, shared by the live session page and the replay
// viewer: "P3's agent raised KeyError: 'evening' (agent.py:88 in assign)". A fault no single player owns
// (the environment itself, say) is charged to the game.
export function failureText(failure: RunFailure | null): string | null {
  if (failure === null) {
    return null
  }
  const source =
    failure.failedPlayer === null ? 'The game' : `${formatPlayer(failure.failedPlayer)}'s agent`
  return `${source} raised ${failure.detail}`
}
