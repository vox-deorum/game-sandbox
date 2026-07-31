import { randomBytes } from 'node:crypto'

import { LlmError } from './errors.js'
import type {
  LlmGrant,
  OfficialGrantTemplate,
  OfficialKeyEntry,
  OfficialTickMarkerRef,
} from './types.js'

type RandomKeyBytes = (size: number) => Uint8Array

/** Generous fallback bound on a single request's in-flight contribution; deployments override it. */
const DEFAULT_MAX_REQUEST_MS = 600_000

export interface KeyRegistryOptions {
  now?: () => number
  /**
   * Upper bound on how much a single in-flight request may contribute to
   * {@link KeyRegistry.inFlightMsForScope} and {@link KeyRegistry.blockingInFlightMs}, matching its
   * configured attempt timeouts and default SDK retry waits. Provider-directed waits beyond this
   * allowance and a per-attempt timeout that never fires remain capped, so outer watchdog discounting
   * can rely on a stuck request's contribution being bounded.
   */
  maxRequestMs?: number
}

interface OfficialSessionState {
  keys: Set<string>
  scopeKeys: Set<string>
  activeRequests: Set<OfficialRequestState>
  closed: boolean
  drain: Promise<void>
  resolveDrain: () => void
}

interface OfficialRequestState {
  controller: AbortController
  cancellable: boolean
  scopeKey: string
  startedAt: number
  background: boolean
}

/** One admitted official request. Releasing it settles the session revocation barrier. */
export interface OfficialRequestAdmission {
  grant: LlmGrant
  signal: AbortSignal
  /** Upstream succeeded, so revocation must drain accounting instead of aborting it. */
  beginFinalization(): void
  release(): void
}

/** Process-lifetime bearer keys for official session containers. */
export class KeyRegistry {
  private readonly official = new Map<string, OfficialKeyEntry>()
  private readonly sessions = new Map<string, OfficialSessionState>()
  /** Cumulative capped in-flight ms per accounting-scope key, spanning success and failure alike. */
  private readonly inFlightByScope = new Map<string, number>()
  /** Blocking subset of cumulative in-flight ms, used only by outer execution watchdogs. */
  private readonly blockingInFlightByScope = new Map<string, number>()
  /** Active requests by accounting scope, used by the hook-timing control read. */
  private readonly activeRequestsByScope = new Map<string, Set<OfficialRequestState>>()
  private readonly now: () => number
  private readonly maxRequestMs: number

  constructor(
    private readonly random: RandomKeyBytes = randomBytes,
    options: KeyRegistryOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.maxRequestMs = options.maxRequestMs ?? DEFAULT_MAX_REQUEST_MS
  }

  issueOfficial(
    sessionId: string,
    grant: OfficialGrantTemplate,
    tick: OfficialTickMarkerRef,
    recordSinkForTick: (tick: number | null) => LlmGrant['recordSink'],
  ): string {
    let state = this.sessions.get(sessionId)
    if (state?.closed === true) {
      throw new Error(`Cannot issue an LLM key while session ${sessionId} is being revoked`)
    }
    state ??= createSessionState()
    let bearer: string
    do {
      bearer = `sk-sandbox-${Buffer.from(this.random(32)).toString('hex')}`
    } while (this.official.has(bearer))
    this.official.set(bearer, { sessionId, grant, tick, recordSinkForTick })
    state.keys.add(bearer)
    state.scopeKeys.add(grant.accountingScope.key)
    this.sessions.set(sessionId, state)
    return bearer
  }

  authenticateRequest(bearer: string, background = false): OfficialRequestAdmission {
    const entry = this.lookup(bearer)
    const state = this.sessions.get(entry.sessionId)
    if (state === undefined || state.closed) throw invalidKey()
    const requestGrant = { ...entry.grant, recordSink: entry.recordSinkForTick(entry.tick.current) }
    const requestState: OfficialRequestState = {
      controller: new AbortController(),
      cancellable: true,
      scopeKey: entry.grant.accountingScope.key,
      startedAt: this.now(),
      background,
    }
    state.activeRequests.add(requestState)
    const activeRequests = this.activeRequestsByScope.get(requestState.scopeKey) ?? new Set()
    activeRequests.add(requestState)
    this.activeRequestsByScope.set(requestState.scopeKey, activeRequests)

    let released = false
    return {
      grant: requestGrant,
      signal: requestState.controller.signal,
      beginFinalization: () => {
        requestState.cancellable = false
      },
      release: () => {
        if (released) return
        released = true
        // The logical request counts across every retry whether it succeeded or failed. Apply the
        // same per-request cap before moving its active partial into the cumulative counter.
        const elapsed = this.activeRequestMs(requestState, this.now())
        const scopeKey = requestState.scopeKey
        this.inFlightByScope.set(scopeKey, (this.inFlightByScope.get(scopeKey) ?? 0) + elapsed)
        if (!requestState.background) {
          this.blockingInFlightByScope.set(
            scopeKey,
            (this.blockingInFlightByScope.get(scopeKey) ?? 0) + elapsed,
          )
        }
        state.activeRequests.delete(requestState)
        const activeRequests = this.activeRequestsByScope.get(scopeKey)
        activeRequests?.delete(requestState)
        if (activeRequests?.size === 0) this.activeRequestsByScope.delete(scopeKey)
        if (state.closed && state.activeRequests.size === 0)
          this.finishRevocation(entry.sessionId, state)
      },
    }
  }

  /** Cumulative proxy ms for one accounting scope, including each active request's capped partial. */
  inFlightMsForScope(scopeKey: string): number {
    let total = this.inFlightByScope.get(scopeKey) ?? 0
    const now = this.now()
    for (const request of this.activeRequestsByScope.get(scopeKey) ?? [])
      total += this.activeRequestMs(request, now)
    return total
  }

  /**
   * Cumulative blocking in-flight ms for a session.
   *
   * Background-marked requests remain part of total hook-time accounting, but never extend the
   * live-session or leaderboard-game watchdog.
   */
  blockingInFlightMs(sessionId: string): number {
    const state = this.sessions.get(sessionId)
    if (state === undefined) return 0
    let total = 0
    for (const scopeKey of state.scopeKeys) total += this.blockingInFlightByScope.get(scopeKey) ?? 0
    const now = this.now()
    for (const request of state.activeRequests) {
      if (!request.background) total += this.activeRequestMs(request, now)
    }
    return total
  }

  private activeRequestMs(request: OfficialRequestState, now: number): number {
    return Math.min(this.maxRequestMs, Math.max(0, Math.round(now - request.startedAt)))
  }

  authenticateOfficial(bearer: string): OfficialKeyEntry {
    return this.lookup(bearer)
  }

  revokeSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (state === undefined) return Promise.resolve()
    if (state.closed) return state.drain

    // Close admission synchronously before exposing the drain promise to teardown callers.
    state.closed = true
    for (const key of state.keys) this.official.delete(key)
    state.keys.clear()
    for (const request of state.activeRequests) {
      if (request.cancellable) request.controller.abort()
    }
    if (state.activeRequests.size === 0) this.finishRevocation(sessionId, state)
    return state.drain
  }

  private lookup(bearer: string): OfficialKeyEntry {
    const entry = this.official.get(bearer)
    if (entry === undefined) throw invalidKey()
    return entry
  }

  private finishRevocation(sessionId: string, state: OfficialSessionState): void {
    if (this.sessions.get(sessionId) !== state) return
    this.sessions.delete(sessionId)
    for (const scopeKey of state.scopeKeys) {
      this.inFlightByScope.delete(scopeKey)
      this.blockingInFlightByScope.delete(scopeKey)
    }
    state.resolveDrain()
  }
}

function createSessionState(): OfficialSessionState {
  let resolveDrain = (): void => {}
  const drain = new Promise<void>((resolve) => {
    resolveDrain = resolve
  })
  return {
    keys: new Set(),
    scopeKeys: new Set(),
    activeRequests: new Set(),
    closed: false,
    drain,
    resolveDrain,
  }
}

function invalidKey(): LlmError {
  return new LlmError(401, 'invalid_api_key', 'Invalid or revoked API key.')
}

export function createOfficialTickMarker(): OfficialTickMarkerRef {
  return { current: null }
}
