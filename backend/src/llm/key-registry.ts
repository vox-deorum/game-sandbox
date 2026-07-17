import { randomBytes } from 'node:crypto'

import { LlmError } from './errors.js'
import type { LlmGrant, OfficialKeyEntry, OfficialTickMarkerRef } from './types.js'

type RandomKeyBytes = (size: number) => Uint8Array

interface OfficialSessionState {
  keys: Set<string>
  activeRequests: Set<OfficialRequestState>
  closed: boolean
  drain: Promise<void>
  resolveDrain: () => void
}

interface OfficialRequestState {
  controller: AbortController
  cancellable: boolean
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

  constructor(private readonly random: RandomKeyBytes = randomBytes) {}

  issueOfficial(sessionId: string, grant: LlmGrant, tick: OfficialTickMarkerRef): string {
    let state = this.sessions.get(sessionId)
    if (state?.closed === true) {
      throw new Error(`Cannot issue an LLM key while session ${sessionId} is being revoked`)
    }
    state ??= createSessionState()
    let bearer: string
    do {
      bearer = `sk-sandbox-${Buffer.from(this.random(32)).toString('hex')}`
    } while (this.official.has(bearer))
    this.official.set(bearer, { sessionId, grant, tick })
    state.keys.add(bearer)
    this.sessions.set(sessionId, state)
    return bearer
  }

  authenticateRequest(bearer: string): OfficialRequestAdmission {
    const entry = this.lookup(bearer)
    const state = this.sessions.get(entry.sessionId)
    if (state === undefined || state.closed) throw invalidKey()
    const requestState: OfficialRequestState = {
      controller: new AbortController(),
      cancellable: true,
    }
    state.activeRequests.add(requestState)

    let released = false
    return {
      grant: entry.grant,
      signal: requestState.controller.signal,
      beginFinalization: () => {
        requestState.cancellable = false
      },
      release: () => {
        if (released) return
        released = true
        state.activeRequests.delete(requestState)
        if (state.closed && state.activeRequests.size === 0)
          this.finishRevocation(entry.sessionId, state)
      },
    }
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
    state.resolveDrain()
  }
}

function createSessionState(): OfficialSessionState {
  let resolveDrain = (): void => {}
  const drain = new Promise<void>((resolve) => {
    resolveDrain = resolve
  })
  return { keys: new Set(), activeRequests: new Set(), closed: false, drain, resolveDrain }
}

function invalidKey(): LlmError {
  return new LlmError(401, 'invalid_api_key', 'Invalid or revoked API key.')
}

export function createOfficialTickMarker(): OfficialTickMarkerRef {
  return { current: null }
}
