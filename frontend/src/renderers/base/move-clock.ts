/**
 * The human move clock a renderer draws.
 *
 * The harness owns the real deadline: it starts counting when it asks a human for an action and
 * substitutes the environment's default action when the budget runs out. Nothing on the wire carries
 * that deadline, so this is the browser's picture of it, opened when the state that puts a controlled
 * player on the clock arrives and counting down the session's budget from there. It therefore runs a
 * network hop behind the harness and restarts full if the page reconnects mid-turn.
 *
 * The clock is wall-clock driven, so it keeps running under a playback pause: only the picture
 * freezes, which is what the interaction specification asks for. Pass a `now` function to drive it
 * from a fake clock in tests.
 */

/** Inside this much remaining time the clock reads as urgent, and renderers draw it in ember. */
export const MOVE_CLOCK_EMBER_MS = 10_000

export interface MoveClockReading {
  /** The session's per-move budget in milliseconds. */
  totalMs: number
  remainingMs: number
  /** One when the turn opens, zero once the budget is spent. */
  fraction: number
  /** Whole seconds left, for a numeric readout. */
  seconds: number
  /** True inside the closing {@link MOVE_CLOCK_EMBER_MS}. */
  ember: boolean
}

function wallClock(): number {
  return performance.now()
}

export class MoveClock {
  private totalMs: number | null = null
  private openedAt = 0
  private turn: string | null = null

  constructor(private readonly now: () => number = wallClock) {}

  /**
   * Put a turn on the clock. Opening the same turn again leaves the countdown alone, so a resize,
   * a camera move, or any other redraw of the same state never gives the person their time back. A
   * missing or non-positive budget means this session has no move clock and closes it instead.
   */
  open(turn: string, totalMs: number | null | undefined): void {
    if (totalMs === null || totalMs === undefined || totalMs <= 0) {
      this.close()
      return
    }
    if (this.turn === turn) return
    this.turn = turn
    this.totalMs = totalMs
    this.openedAt = this.now()
  }

  /** Take the clock off, for a turn nobody here controls, a finished match, or a session without one. */
  close(): void {
    this.turn = null
    this.totalMs = null
  }

  /** The current reading, or null when no clock is running. */
  read(): MoveClockReading | null {
    const totalMs = this.totalMs
    if (totalMs === null) return null
    const remainingMs = Math.min(totalMs, Math.max(0, totalMs - (this.now() - this.openedAt)))
    return {
      totalMs,
      remainingMs,
      fraction: remainingMs / totalMs,
      seconds: Math.ceil(remainingMs / 1000),
      ember: remainingMs <= MOVE_CLOCK_EMBER_MS,
    }
  }
}
