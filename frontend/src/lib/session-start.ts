import type { Router } from 'vue-router'

import type { StartSessionResult } from '../api/client.js'
import { PENDING_START_MESSAGE } from '../me.js'

export const SESSION_START_FAILED_MESSAGE = 'Could not start the session. Please try again.'

/** What a session-start caller does after the typed API result. */
export type SessionStartResolution =
  | { kind: 'navigated' }
  | { kind: 'already_active'; activeSessionId: string }
  | { kind: 'error'; message: string }

/** Navigate for a successful start, surface a conflict, or return a caller-rendered error. */
export async function handleSessionStartResult(
  result: StartSessionResult,
  router: Pick<Router, 'push'>,
): Promise<SessionStartResolution> {
  if (result.ok) {
    await router.push(`/sessions/${result.session.id}`)
    return { kind: 'navigated' }
  }
  if (result.reason === 'already_active') {
    return { kind: 'already_active', activeSessionId: result.activeSessionId }
  }
  if (result.reason === 'not_active') return { kind: 'error', message: PENDING_START_MESSAGE }
  if (result.reason === 'play_season_changed') {
    return {
      kind: 'error',
      message: 'The play season changed. Refresh this page and reopen the start form.',
    }
  }
  if (result.reason === 'invalid_parameters') {
    return {
      kind: 'error',
      message: 'The game settings changed. Refresh this page and reopen the start form.',
    }
  }
  return { kind: 'error', message: result.message }
}
