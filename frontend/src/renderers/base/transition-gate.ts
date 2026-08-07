/**
 * The promise a host waits on while one state's transition plays.
 *
 * A paced host (the replay transport, the live session pump) delivers the next frame only once the
 * previous one has both met its cadence and actually finished animating, so `render` hands back a
 * promise and something has to decide when it settles. That is this: one waiter at a time, settled by
 * whoever gets there first.
 *
 * Three things settle it, and all three are ordinary rather than exceptional:
 *
 * - the transition ending, which is the case the host is actually waiting for;
 * - a superseding render, because the host that was waiting has already moved on;
 * - teardown, so a page closing mid-animation never leaves a pump hanging on a dead renderer.
 *
 * There is no rejection path. A host awaits a frame to pace itself, not to find out whether the
 * drawing succeeded, so a settled promise means only "stop waiting".
 */
export class TransitionGate {
  private resolve: (() => void) | null = null

  /** Whether anything is currently waiting. */
  get pending(): boolean {
    return this.resolve !== null
  }

  /** Hand out a promise the next {@link settle} resolves, replacing any earlier waiter. */
  wait(): Promise<void> {
    this.settle()
    return new Promise<void>((resolve) => {
      this.resolve = resolve
    })
  }

  /** Release the waiter, if there is one. Safe to call when there is not. */
  settle(): void {
    const resolve = this.resolve
    this.resolve = null
    resolve?.()
  }
}
