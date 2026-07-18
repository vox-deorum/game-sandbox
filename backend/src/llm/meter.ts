import { performance } from 'node:perf_hooks'

import { LlmError } from './errors.js'
import {
  committedCalls,
  type LlmAccountingScope,
  type LlmRecordSink,
  type LlmSuccessfulRecord,
  type ModelAlias,
  weightedCommittedTokens,
} from './types.js'

/** One sliding-window horizon shared by recorded events and pending capacity. */
const RATE_WINDOW_MS = 60_000

interface MeterState {
  rateEvents: number[]
  pendingRateEvents: Set<LlmReservation>
  reservedCalls: number
  reservedWeightedTokens: number
  debt: { calls: number; weightedTokens: number }
  breakerOpen: boolean
  probing: boolean
  recoveryTimer: ReturnType<typeof setTimeout> | null
}

export interface LlmReservation {
  readonly scope: LlmAccountingScope
  readonly model: ModelAlias
  readonly inputTokens: number
  readonly outputTokens: number
  readonly weightedTokens: number
  /** Admission instant that stamps this request's rate event and bounds its pending capacity. */
  readonly rateStartedAt: number
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
    // The window only ever compares its own readings, so a monotonic clock keeps a wall-clock step
    // (e.g. an NTP correction) from stranding an event in the window or expiring it early.
    this.now = options.now ?? (() => performance.now())
    this.schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay))
    this.cancel = options.cancel ?? clearTimeout
    this.log = options.log ?? (() => {})
  }

  /** Atomically read committed usage, check the scope, and reserve it as one sync section. */
  async reserve(
    scope: LlmAccountingScope,
    model: ModelAlias,
    inputTokens: number,
    outputTokens: number,
  ): Promise<LlmReservation> {
    const now = this.now()
    const requestedTokens = inputTokens + outputTokens
    const weight = scope.weights[model]
    if (weight === undefined) {
      throw new Error(`LLM accounting scope has no cost weight for model ${model}`)
    }
    const requestedWeightedTokens = weight * requestedTokens

    const state = this.state(scope.key)
    this.pruneRateWindows(state, now)
    if (state.breakerOpen) {
      throw new LlmError(503, 'meter_unavailable', 'Usage accounting is temporarily unavailable.')
    }
    // Never touch a known-unhealthy store while its pair-scoped breaker is open. Once admitted to
    // the read, the durable reader is synchronous, so no commit can land before reservation.
    const usage = scope.readCommittedUsage()
    if (state.rateEvents.length + state.pendingRateEvents.size >= scope.limits.requestsPerMinute) {
      throw new LlmError(429, 'rate_limit_exceeded', 'Rate limit exceeded.', 'rate_limit_error')
    }
    if (
      committedCalls(usage) + state.reservedCalls + state.debt.calls + 1 >
      scope.limits.callBudget
    ) {
      throw new LlmError(400, 'budget_exceeded', 'Call budget exceeded.')
    }
    if (
      weightedCommittedTokens(usage, scope.weights) +
        state.reservedWeightedTokens +
        state.debt.weightedTokens +
        requestedWeightedTokens >
      scope.limits.tokenBudget
    ) {
      throw new LlmError(400, 'budget_exceeded', 'Token budget exceeded.')
    }

    const reservation: LlmReservation = {
      scope,
      model,
      inputTokens,
      outputTokens,
      weightedTokens: requestedWeightedTokens,
      rateStartedAt: now,
      active: true,
    }
    state.pendingRateEvents.add(reservation)
    state.reservedCalls += 1
    state.reservedWeightedTokens += requestedWeightedTokens
    return reservation
  }

  /**
   * Convert one request's pending rate capacity into a successful event stamped at its admission
   * time. Call this after upstream success and before any finalizer, ahead of durable accounting,
   * so the event survives a post-upstream accounting failure. A failed or exhausted-retry request
   * instead releases its capacity via {@link release} and records nothing, as does a success whose
   * start has already left the sliding window, since its event could no longer influence admission.
   */
  recordRateEvent(reservation: LlmReservation): void {
    if (!reservation.active) throw new Error('LLM rate reservation was already finalized')
    const state = this.state(reservation.scope.key)
    // Set membership is the single source of pending truth: a slot already converted, or expired by
    // the prune, records nothing. A duplicate call on a live reservation is likewise a no-op.
    if (!state.pendingRateEvents.delete(reservation)) return
    if (this.now() - reservation.rateStartedAt >= RATE_WINDOW_MS) return
    state.rateEvents.push(reservation.rateStartedAt)
    // Concurrent requests can finish out of admission order; pruning assumes ascending timestamps.
    state.rateEvents.sort((left, right) => left - right)
  }

  /** Release an unsuccessful request without committing call or token spend. */
  release(reservation: LlmReservation): void {
    if (!reservation.active) return
    reservation.active = false
    const state = this.state(reservation.scope.key)
    state.pendingRateEvents.delete(reservation)
    state.reservedCalls -= 1
    state.reservedWeightedTokens -= reservation.weightedTokens
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

  /** Retain an upstream-spent reservation and block its scope when post-call accounting fails. */
  chargeConservativeDebt(reservation: LlmReservation, sink: LlmRecordSink): void {
    if (!reservation.active) return
    this.moveToDebt(reservation)
    this.openBreaker(reservation.scope.key, sink)
  }

  /**
   * Open a scope's breaker when its durable store failed outside a commit (e.g. a grant's ledger
   * open/migration on the request path), so later reservations fail fast until a probe recovers it.
   */
  markUnavailable(scope: LlmAccountingScope, sink: LlmRecordSink): void {
    this.openBreaker(scope.key, sink)
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
    this.release(reservation)
    const state = this.state(reservation.scope.key)
    state.debt.calls += 1
    state.debt.weightedTokens += reservation.weightedTokens
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

  /** Expire recorded events and pending capacity together on the shared window horizon. */
  private pruneRateWindows(state: MeterState, now: number): void {
    const cutoff = now - RATE_WINDOW_MS
    let first = 0
    while (first < state.rateEvents.length && (state.rateEvents[first] as number) <= cutoff) first++
    if (first > 0) state.rateEvents.splice(0, first)
    for (const reservation of state.pendingRateEvents) {
      if (reservation.rateStartedAt <= cutoff) state.pendingRateEvents.delete(reservation)
    }
  }

  private state(key: string): MeterState {
    let state = this.states.get(key)
    if (state === undefined) {
      state = {
        rateEvents: [],
        pendingRateEvents: new Set(),
        reservedCalls: 0,
        reservedWeightedTokens: 0,
        debt: { calls: 0, weightedTokens: 0 },
        breakerOpen: false,
        probing: false,
        recoveryTimer: null,
      }
      this.states.set(key, state)
    }
    return state
  }
}
