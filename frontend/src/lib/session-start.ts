import type { Router } from 'vue-router'

import type { StartSessionResult } from '../api/client.js'
import { PENDING_START_MESSAGE } from '../me.js'

/** Navigate for success/rejoin and return any caller-rendered error. */
export async function handleSessionStartResult(
  result: StartSessionResult,
  router: Pick<Router, 'push'>,
): Promise<string | null> {
  if (result.ok) {
    await router.push(`/sessions/${result.session.id}`)
    return null
  }
  if (result.reason === 'already_active') {
    await router.push(`/sessions/${result.activeSessionId}`)
    return null
  }
  if (result.reason === 'not_active') return PENDING_START_MESSAGE
  if (result.reason === 'play_season_changed') {
    return 'The play season changed. Refresh this page and reopen the start form.'
  }
  if (result.reason === 'invalid_parameters') {
    return 'The game settings changed. Refresh this page and reopen the start form.'
  }
  return result.message
}
