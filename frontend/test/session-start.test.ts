import { describe, expect, it, vi } from 'vitest'

import type { StartSessionResult } from '../src/api/client.js'
import { handleSessionStartResult } from '../src/lib/session-start.js'

describe('handleSessionStartResult', () => {
  it('returns the stale-season message and does not navigate', async () => {
    const push = vi.fn()
    const result: StartSessionResult = { ok: false, reason: 'play_season_changed' }
    expect(await handleSessionStartResult(result, { push })).toEqual({
      kind: 'error',
      message: 'The play season changed. Refresh this page and reopen the start form.',
    })
    expect(push).not.toHaveBeenCalled()
  })

  it('returns the changed-settings message and does not navigate', async () => {
    const push = vi.fn()
    const result: StartSessionResult = { ok: false, reason: 'invalid_parameters' }
    expect(await handleSessionStartResult(result, { push })).toEqual({
      kind: 'error',
      message: 'The game settings changed. Refresh this page and reopen the start form.',
    })
    expect(push).not.toHaveBeenCalled()
  })

  it('returns an active-session conflict without navigating', async () => {
    const push = vi.fn()
    const result: StartSessionResult = {
      ok: false,
      reason: 'already_active',
      activeSessionId: 'active-9',
    }
    expect(await handleSessionStartResult(result, { push })).toEqual({
      kind: 'already_active',
      activeSessionId: 'active-9',
    })
    expect(push).not.toHaveBeenCalled()
  })
})
