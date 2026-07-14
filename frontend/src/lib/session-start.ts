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
  return result.reason === 'not_active' ? PENDING_START_MESSAGE : result.message
}
