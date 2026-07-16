import { randomBytes } from 'node:crypto'

import { LlmError } from './errors.js'
import type { LlmGrant, OfficialKeyEntry, OfficialTickMarkerRef } from './types.js'

type RandomKeyBytes = (size: number) => Uint8Array

/** Process-lifetime bearer keys for official session containers. */
export class KeyRegistry {
  private readonly official = new Map<string, OfficialKeyEntry>()
  private readonly bySession = new Map<string, Set<string>>()

  constructor(private readonly random: RandomKeyBytes = randomBytes) {}

  issueOfficial(sessionId: string, grant: LlmGrant, tick: OfficialTickMarkerRef): string {
    let bearer: string
    do {
      bearer = `sk-sandbox-${Buffer.from(this.random(32)).toString('hex')}`
    } while (this.official.has(bearer))
    this.official.set(bearer, { sessionId, grant, tick })
    const keys = this.bySession.get(sessionId) ?? new Set<string>()
    keys.add(bearer)
    this.bySession.set(sessionId, keys)
    return bearer
  }

  authenticateGrant(bearer: string): LlmGrant {
    return this.lookup(bearer).grant
  }

  authenticateOfficial(bearer: string): OfficialKeyEntry {
    return this.lookup(bearer)
  }

  revokeSession(sessionId: string): void {
    const keys = this.bySession.get(sessionId)
    if (keys === undefined) return
    for (const key of keys) this.official.delete(key)
    this.bySession.delete(sessionId)
  }

  private lookup(bearer: string): OfficialKeyEntry {
    const entry = this.official.get(bearer)
    if (entry === undefined) {
      throw new LlmError(401, 'invalid_api_key', 'Invalid or revoked API key.')
    }
    return entry
  }
}

export function createOfficialTickMarker(): OfficialTickMarkerRef {
  return { current: null }
}
