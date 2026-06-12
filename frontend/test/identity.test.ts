import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  currentUserId,
  IDENTITY_HEADER,
  identityHeaders,
  withIdentityParam,
} from '../src/identity.js'

describe('identity', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('resolves the dev-user fallback when no override is set', () => {
    expect(currentUserId).toBe('dev-user')
  })

  it('attaches the identity header to every request', () => {
    expect(identityHeaders()).toEqual({ [IDENTITY_HEADER]: 'dev-user' })
  })

  it('appends the user query parameter to a socket URL', () => {
    const url = withIdentityParam(new URL('ws://localhost/api/sessions/s1/ws'))
    expect(url.searchParams.get('user')).toBe('dev-user')
  })

  it('honors the VITE_SANDBOX_USER dev override', async () => {
    vi.stubEnv('VITE_SANDBOX_USER', 'tester')
    vi.resetModules()
    const reloaded = await import('../src/identity.js')
    expect(reloaded.currentUserId).toBe('tester')
  })
})
