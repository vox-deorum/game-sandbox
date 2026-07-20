export interface ChargeableTimer {
  timedOut(): boolean
  stop(): void
}

export interface ChargeableTimerOptions {
  budgetMs: number
  inFlightMs?: () => number
  onExpire: () => void
  log: (message: string) => void
}

/** Start a wall-clock timer that excludes verified proxy time without bridging unavailable samples. */
export function createChargeableTimer(options: ChargeableTimerOptions): ChargeableTimer {
  let fired = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const startedAt = Date.now()
  let sampledAt = startedAt
  let sampledInFlightMs = readInFlightMs(options)
  let discountMs = 0

  const sampleChargeableElapsedMs = (): number => {
    const now = Date.now()
    const elapsedMs = Math.max(0, now - startedAt)
    const inFlightMs = readInFlightMs(options)
    if (inFlightMs === null) {
      sampledAt = now
      sampledInFlightMs = null
      return Math.max(0, elapsedMs - discountMs)
    }
    if (sampledInFlightMs !== null) {
      const wallDeltaMs = Math.max(0, now - sampledAt)
      const inFlightDeltaMs = Math.max(0, inFlightMs - sampledInFlightMs)
      discountMs += Math.min(wallDeltaMs, inFlightDeltaMs)
    }
    sampledAt = now
    sampledInFlightMs = inFlightMs
    return Math.max(0, elapsedMs - discountMs)
  }

  const arm = (delayMs: number): void => {
    if (stopped || fired) return
    timer = setTimeout(
      () => {
        timer = null
        if (stopped || fired) return
        const chargeableElapsedMs = sampleChargeableElapsedMs()
        if (chargeableElapsedMs < options.budgetMs) {
          arm(Math.max(1, options.budgetMs - chargeableElapsedMs))
          return
        }
        fired = true
        options.onExpire()
      },
      Math.max(1, delayMs),
    )
  }

  arm(options.budgetMs)
  return {
    timedOut: () => fired,
    stop: () => {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
  }
}

function readInFlightMs(options: ChargeableTimerOptions): number | null {
  if (options.inFlightMs === undefined) return 0
  try {
    const reported = options.inFlightMs()
    if (typeof reported === 'number' && Number.isFinite(reported)) {
      return Math.max(0, reported)
    }
    options.log('LLM in-flight timing was not finite')
  } catch (error) {
    options.log(`LLM in-flight timing failed: ${String(error)}`)
  }
  return null
}
