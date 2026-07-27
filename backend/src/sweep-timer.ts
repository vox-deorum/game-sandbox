/** Run a sweep at startup and on a repeating, non-blocking process timer. */
export class SweepTimer {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly sweep: () => void,
    private readonly intervalMs: number,
  ) {}

  /** Run the sweep now, then repeat it on the configured interval. */
  start(): void {
    this.sweep()
    this.timer = setInterval(() => this.sweep(), this.intervalMs)
    // Don't keep the process alive solely for the sweep timer.
    this.timer.unref?.()
  }

  /** Stop the current interval timer (process shutdown). */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
