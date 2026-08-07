/**
 * The human move clock a renderer draws.
 *
 * The harness owns the real budget: it substitutes the environment's default action once a person has
 * held the controls for longer than it. This is the browser's picture of that budget, opened when the
 * renderer opens the controls. Both start on the same event, so the picture tracks the harness within
 * a network hop, and {@link hold} freezes it for the same spans the harness does not charge. A page
 * that reconnects mid-turn restarts this picture at full while the harness keeps the time it already
 * spent, so the reading is generous there.
 *
 * Pass a `now` function to drive it from a fake clock in tests.
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
  /** When the clock was frozen, or null when it is running. */
  private heldAt: number | null = null

  constructor(private readonly now: () => number = wallClock) {}

  /** The instant the reading is taken from: frozen time while held, otherwise now. */
  private at(): number {
    return this.heldAt ?? this.now()
  }

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
    this.openedAt = this.at()
  }

  /** Take the clock off, for a turn nobody here controls, a finished match, or a session without one. */
  close(): void {
    this.turn = null
    this.totalMs = null
  }

  /** Freeze the countdown. Holding an already-held clock leaves the frozen instant alone. */
  hold(): void {
    this.heldAt ??= this.now()
  }

  /** Start counting again, giving back every millisecond spent held. */
  resume(): void {
    if (this.heldAt === null) return
    this.openedAt += this.now() - this.heldAt
    this.heldAt = null
  }

  /** The current reading, or null when no clock is running. */
  read(): MoveClockReading | null {
    const totalMs = this.totalMs
    if (totalMs === null) return null
    const remainingMs = Math.min(totalMs, Math.max(0, totalMs - (this.at() - this.openedAt)))
    return {
      totalMs,
      remainingMs,
      fraction: remainingMs / totalMs,
      seconds: Math.ceil(remainingMs / 1000),
      ember: remainingMs <= MOVE_CLOCK_EMBER_MS,
    }
  }
}
