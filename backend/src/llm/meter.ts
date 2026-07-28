import { performance } from 'node:perf_hooks'

import { LlmError } from './errors.js'
import {
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
  reservedWeightedTokens: number
  unavailable: boolean
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
  now?: () => number
  log?: (message: string) => void
}

/** Process-lifetime reservations, rate windows, and unavailable accounting scopes. */
export class LlmMeter {
  private readonly states = new Map<string, MeterState>()
  private readonly now: () => number
  private readonly log: (message: string) => void

  constructor(options: LlmMeterOptions = {}) {
    // The window only ever compares its own readings, so a monotonic clock keeps a wall-clock step
    // (e.g. an NTP correction) from stranding an event in the window or expiring it early.
    this.now = options.now ?? (() => performance.now())
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
    if (state.unavailable) {
      throw new LlmError(503, 'meter_unavailable', 'Usage accounting is temporarily unavailable.')
    }
    // Never touch a known-unavailable store. Once admitted to the read, the durable reader is
    // synchronous, so no commit can land before reservation.
    const usage = scope.readCommittedUsage()
    if (state.rateEvents.length + state.pendingRateEvents.size >= scope.limits.requestsPerMinute) {
      throw new LlmError(429, 'rate_limit_exceeded', 'Rate limit exceeded.', 'rate_limit_error')
    }
    if (
      weightedCommittedTokens(usage, scope.weights) +
        state.reservedWeightedTokens +
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
    // Set membership is the single source of pending truth: a reservation already converted, or expired by
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
    state.reservedWeightedTokens -= reservation.weightedTokens
  }

  /** Commit telemetry before releasing the reservation; block the scope if recording fails. */
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
      this.release(reservation)
      this.markUnavailable(reservation.scope)
      throw new LlmError(503, 'meter_unavailable', 'Usage accounting is temporarily unavailable.')
    }
  }

  /** Block a scope after an accounting failure until this process restarts. */
  markUnavailable(scope: LlmAccountingScope): void {
    const state = this.state(scope.key)
    if (state.unavailable) return
    state.unavailable = true
    this.log(`LLM meter ${scope.key}: usage accounting is unavailable until restart`)
  }

  inspect(key: string): Readonly<MeterState> {
    return this.state(key)
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
        reservedWeightedTokens: 0,
        unavailable: false,
      }
      this.states.set(key, state)
    }
    return state
  }
}
