import { LlmError } from './errors.js'
import {
  emptyUsage,
  type LlmAccountingScope,
  type LlmRecordSink,
  type LlmSuccessfulRecord,
  type LlmUsage,
  totalTokens,
} from './types.js'

interface MeterState {
  rateEvents: number[]
  reservedCalls: number
  reservedTokens: number
  debt: LlmUsage
  breakerOpen: boolean
  probing: boolean
  recoveryTimer: ReturnType<typeof setTimeout> | null
}

export interface LlmReservation {
  readonly scopes: readonly LlmAccountingScope[]
  readonly inputTokens: number
  readonly outputTokens: number
  active: boolean
}

export interface LlmMeterOptions {
  recoveryIntervalMs: number
  now?: () => number
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  cancel?: (timer: ReturnType<typeof setTimeout>) => void
  log?: (message: string) => void
}

/** Process-lifetime reservations, rate windows, conservative debt, and storage breakers. */
export class LlmMeter {
  private readonly states = new Map<string, MeterState>()
  private readonly now: () => number
  private readonly schedule: NonNullable<LlmMeterOptions['schedule']>
  private readonly cancel: NonNullable<LlmMeterOptions['cancel']>
  private readonly log: (message: string) => void

  constructor(private readonly options: LlmMeterOptions) {
    this.now = options.now ?? Date.now
    this.schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay))
    this.cancel = options.cancel ?? clearTimeout
    this.log = options.log ?? (() => {})
  }

  /** Atomically read committed usage, check every scope, and reserve them as one sync section. */
  async reserve(
    scopes: readonly LlmAccountingScope[],
    inputTokens: number,
    outputTokens: number,
  ): Promise<LlmReservation> {
    const unique = uniqueScopes(scopes)
    const committed = unique.map((scope) => scope.readCommittedUsage())
    const now = this.now()
    const requestedTokens = inputTokens + outputTokens

    // Durable readers are synchronous, so no commit can land between this snapshot and reservation.
    for (let index = 0; index < unique.length; index++) {
      const scope = unique[index] as LlmAccountingScope
      const usage = committed[index] as LlmUsage
      const state = this.state(scope.key)
      this.pruneRateWindow(state, now)
      if (state.breakerOpen) {
        throw new LlmError(503, 'meter_unavailable', 'Usage accounting is temporarily unavailable.')
      }
      if (state.rateEvents.length >= scope.limits.requestsPerMinute) {
        throw new LlmError(429, 'rate_limit_exceeded', 'Rate limit exceeded.', 'rate_limit_error')
      }
      if (usage.calls + state.reservedCalls + state.debt.calls + 1 > scope.limits.callBudget) {
        throw new LlmError(400, 'budget_exceeded', 'Call budget exceeded.')
      }
      const committedTokens = totalTokens(usage)
      const debtTokens = totalTokens(state.debt)
      if (
        committedTokens + state.reservedTokens + debtTokens + requestedTokens >
        scope.limits.tokenBudget
      ) {
        throw new LlmError(400, 'budget_exceeded', 'Token budget exceeded.')
      }
    }

    for (const scope of unique) {
      const state = this.state(scope.key)
      state.rateEvents.push(now)
      state.reservedCalls += 1
      state.reservedTokens += requestedTokens
    }
    return { scopes: unique, inputTokens, outputTokens, active: true }
  }

  /** Release an unsuccessful request without committing call or token spend. */
  release(reservation: LlmReservation): void {
    if (!reservation.active) return
    reservation.active = false
    const tokens = reservation.inputTokens + reservation.outputTokens
    for (const scope of reservation.scopes) {
      const state = this.state(scope.key)
      state.reservedCalls -= 1
      state.reservedTokens -= tokens
    }
  }

  /** Commit telemetry before releasing the reservation; retain conservative debt on failure. */
  async commit(
    reservation: LlmReservation,
    sink: LlmRecordSink,
    record: LlmSuccessfulRecord,
  ): Promise<void> {
    if (!reservation.active) throw new Error('LLM reservation was already finalized')
    try {
      await sink.record(record)
      this.release(reservation)
    } catch {
      this.chargeConservativeDebt(reservation, sink)
      throw new LlmError(503, 'meter_unavailable', 'Usage accounting is temporarily unavailable.')
    }
  }

  /** Retain an upstream-spent reservation and block its scopes when post-call accounting fails. */
  chargeConservativeDebt(reservation: LlmReservation, sink: LlmRecordSink): void {
    if (!reservation.active) return
    this.moveToDebt(reservation)
    for (const scope of reservation.scopes) this.openBreaker(scope.key, sink)
  }

  /** Used by startup wiring when a scope's initial migration/write-health check fails. */
  markUnavailable(scopes: readonly LlmAccountingScope[], sink: LlmRecordSink): void {
    for (const scope of uniqueScopes(scopes)) this.openBreaker(scope.key, sink)
  }

  inspect(key: string): Readonly<MeterState> {
    return this.state(key)
  }

  close(): void {
    for (const state of this.states.values()) {
      if (state.recoveryTimer !== null) this.cancel(state.recoveryTimer)
      state.recoveryTimer = null
    }
  }

  private moveToDebt(reservation: LlmReservation): void {
    if (!reservation.active) return
    reservation.active = false
    const tokens = reservation.inputTokens + reservation.outputTokens
    for (const scope of reservation.scopes) {
      const state = this.state(scope.key)
      state.reservedCalls -= 1
      state.reservedTokens -= tokens
      state.debt.calls += 1
      state.debt.inputTokens += reservation.inputTokens
      // The reservation is conservative and does not separately guess hidden reasoning.
      state.debt.outputTokens += reservation.outputTokens
    }
  }

  private openBreaker(key: string, sink: LlmRecordSink): void {
    const state = this.state(key)
    if (!state.breakerOpen) this.log(`LLM meter ${key}: circuit breaker opened`)
    state.breakerOpen = true
    if (state.recoveryTimer === null && !state.probing) {
      state.recoveryTimer = this.schedule(() => {
        state.recoveryTimer = null
        void this.probe(key, sink)
      }, this.options.recoveryIntervalMs)
      state.recoveryTimer.unref?.()
    }
  }

  private async probe(key: string, sink: LlmRecordSink): Promise<void> {
    const state = this.state(key)
    if (!state.breakerOpen || state.probing) return
    state.probing = true
    try {
      await sink.probeHealth()
      state.breakerOpen = false
      this.log(`LLM meter ${key}: circuit breaker closed`)
    } catch {
      this.log(`LLM meter ${key}: recovery probe failed`)
      this.openBreaker(key, sink)
    } finally {
      state.probing = false
      // openBreaker saw probing=true on failure, so schedule the next bounded probe here.
      if (state.breakerOpen && state.recoveryTimer === null) this.openBreaker(key, sink)
    }
  }

  private pruneRateWindow(state: MeterState, now: number): void {
    const cutoff = now - 60_000
    let first = 0
    while (first < state.rateEvents.length && (state.rateEvents[first] as number) <= cutoff) first++
    if (first > 0) state.rateEvents.splice(0, first)
  }

  private state(key: string): MeterState {
    let state = this.states.get(key)
    if (state === undefined) {
      state = {
        rateEvents: [],
        reservedCalls: 0,
        reservedTokens: 0,
        debt: emptyUsage(),
        breakerOpen: false,
        probing: false,
        recoveryTimer: null,
      }
      this.states.set(key, state)
    }
    return state
  }
}

function uniqueScopes(scopes: readonly LlmAccountingScope[]): LlmAccountingScope[] {
  const unique = new Map<string, LlmAccountingScope>()
  for (const scope of scopes) {
    if (!unique.has(scope.key)) unique.set(scope.key, scope)
  }
  return [...unique.values()]
}
