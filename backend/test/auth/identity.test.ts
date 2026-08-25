import { maskedAgentLabel, maskedUserHash } from '@game-sandbox/schema/accounts'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import type { Auth } from '../../src/auth/auth.js'
import {
  createRequestIdentity,
  deriveStatus,
  namesVisible,
  type UserStatus,
} from '../../src/auth/identity.js'

/** A session user as Better Auth's admin plugin shapes the fields the seam reads. */
interface StubUser {
  id: string
  name: string
  email: string
  image?: string | null
  role?: string | null
  banned?: boolean | null
}

/** An `Auth` stub whose `getSession` returns a canned session (or null for anonymous). */
function stubAuth(user: StubUser | null): Auth {
  return {
    api: {
      getSession: () => Promise.resolve(user === null ? null : { session: {}, user }),
    },
  } as unknown as Auth
}

/** A minimal request carrying only the cookie header the seam reads. */
function stubRequest(cookie = 'session=token'): FastifyRequest {
  return { headers: { cookie } } as unknown as FastifyRequest
}

/** A reply double recording the status and body a guard sends. */
function stubReply(): { reply: FastifyReply; sent: { status?: number; body?: unknown } } {
  const sent: { status?: number; body?: unknown } = {}
  const reply = {
    code(status: number) {
      sent.status = status
      return reply
    },
    send(body: unknown) {
      sent.body = body
      return reply
    },
  }
  return { reply: reply as unknown as FastifyReply, sent }
}

describe('deriveStatus', () => {
  it('maps the scalar roles a supported operation writes', () => {
    expect(deriveStatus('admin')).toBe('admin')
    expect(deriveStatus('user')).toBe('normal')
    expect(deriveStatus('guest')).toBe('guest')
    expect(deriveStatus('pending')).toBe('pending')
  })

  it('applies admin-over-user-over-guest-over-pending precedence to a comma-split role', () => {
    expect(deriveStatus('admin,user')).toBe('admin')
    expect(deriveStatus('pending,user')).toBe('normal')
    expect(deriveStatus('user,admin')).toBe('admin')
    expect(deriveStatus('user,guest')).toBe('normal')
    expect(deriveStatus('guest,user')).toBe('normal')
    expect(deriveStatus('guest,pending')).toBe('guest')
    expect(deriveStatus('pending,guest')).toBe('guest')
    expect(deriveStatus('guest,admin')).toBe('admin')
  })

  it('falls through a missing, empty, or unknown role to pending (fails closed)', () => {
    expect(deriveStatus(undefined)).toBe('pending')
    expect(deriveStatus(null)).toBe('pending')
    expect(deriveStatus('')).toBe('pending')
    expect(deriveStatus('  ,  ')).toBe('pending')
    expect(deriveStatus('superuser')).toBe('pending')
  })
})

describe('masked labels', () => {
  it('hashes a user id into a stable 6-character hex label', () => {
    const first = maskedUserHash('user-1')
    const second = maskedUserHash('user-1')
    expect(first).toMatch(/^[0-9a-f]{6}$/)
    expect(second).toBe(first)
    // Distinct ids do not collide trivially.
    expect(maskedUserHash('user-2')).not.toBe(first)
  })

  it('wraps the hash in the one Agent label form', () => {
    expect(maskedAgentLabel('user-9')).toBe(`Agent ${maskedUserHash('user-9')}`)
  })
})

describe('createRequestIdentity.resolveUser', () => {
  it('maps a session user through deriveStatus', async () => {
    const identity = createRequestIdentity(
      stubAuth({ id: 'u1', name: 'Ann', email: 'ann@test.local', role: 'user' }),
    )
    expect(await identity.resolveUser(stubRequest())).toEqual({
      id: 'u1',
      name: 'Ann',
      email: 'ann@test.local',
      image: null,
      githubUsername: null,
      status: 'normal',
    })
  })

  it('returns null for an anonymous request', async () => {
    const identity = createRequestIdentity(stubAuth(null))
    expect(await identity.resolveUser(stubRequest())).toBeNull()
  })

  it('treats a banned user as anonymous (defense in depth)', async () => {
    const identity = createRequestIdentity(
      stubAuth({ id: 'u1', name: 'Ann', email: 'ann@test.local', role: 'admin', banned: true }),
    )
    expect(await identity.resolveUser(stubRequest())).toBeNull()
  })
})

describe('createRequestIdentity guards', () => {
  it('requireUser sends 401 auth_required for an anonymous request', async () => {
    const identity = createRequestIdentity(stubAuth(null))
    const { reply, sent } = stubReply()
    expect(await identity.requireUser(stubRequest(), reply)).toBeUndefined()
    expect(sent.status).toBe(401)
    expect(sent.body).toMatchObject({ code: 'auth_required' })
  })

  it('requireActive sends 403 not_active for a pending user', async () => {
    const identity = createRequestIdentity(
      stubAuth({ id: 'u1', name: 'P', email: 'p@test.local', role: 'pending' }),
    )
    const { reply, sent } = stubReply()
    expect(await identity.requireActive(stubRequest(), reply)).toBeUndefined()
    expect(sent.status).toBe(403)
    expect(sent.body).toMatchObject({ code: 'not_active' })
  })

  it('requireActive refuses a guest (they play but do not participate)', async () => {
    const identity = createRequestIdentity(
      stubAuth({ id: 'u1', name: 'G', email: 'g@test.local', role: 'guest' }),
    )
    const { reply, sent } = stubReply()
    expect(await identity.requireActive(stubRequest(), reply)).toBeUndefined()
    expect(sent.status).toBe(403)
    expect(sent.body).toMatchObject({ code: 'not_active' })
  })

  it('requirePlayer admits a guest but refuses a pending user', async () => {
    const guest = createRequestIdentity(
      stubAuth({ id: 'u1', name: 'G', email: 'g@test.local', role: 'guest' }),
    )
    const guestReply = stubReply()
    expect((await guest.requirePlayer(stubRequest(), guestReply.reply))?.status).toBe('guest')
    expect(guestReply.sent.status).toBeUndefined()

    const pending = createRequestIdentity(
      stubAuth({ id: 'u2', name: 'P', email: 'p@test.local', role: 'pending' }),
    )
    const pendingReply = stubReply()
    expect(await pending.requirePlayer(stubRequest(), pendingReply.reply)).toBeUndefined()
    expect(pendingReply.sent.status).toBe(403)
    expect(pendingReply.sent.body).toMatchObject({ code: 'not_active' })
  })

  it('namesVisible is false for anonymous and guest callers, true for signed-in participants', async () => {
    const statuses: UserStatus[] = ['pending', 'normal', 'admin']
    for (const status of statuses) {
      expect(
        namesVisible({
          id: 'u',
          name: 'N',
          email: 'n@x',
          image: null,
          githubUsername: null,
          status,
        }),
      ).toBe(true)
    }
    expect(namesVisible(null)).toBe(false)
    expect(
      namesVisible({
        id: 'u',
        name: 'G',
        email: 'g@x',
        image: null,
        githubUsername: null,
        status: 'guest',
      }),
    ).toBe(false)
  })

  it('requireActive admits a normal user', async () => {
    const identity = createRequestIdentity(
      stubAuth({ id: 'u1', name: 'N', email: 'n@test.local', role: 'user' }),
    )
    const { reply, sent } = stubReply()
    const user = await identity.requireActive(stubRequest(), reply)
    expect(user?.id).toBe('u1')
    expect(sent.status).toBeUndefined()
  })

  it('requireAdmin sends 403 not_operator for a non-admin user', async () => {
    const identity = createRequestIdentity(
      stubAuth({ id: 'u1', name: 'N', email: 'n@test.local', role: 'user' }),
    )
    const { reply, sent } = stubReply()
    expect(await identity.requireAdmin(stubRequest(), reply)).toBeUndefined()
    expect(sent.status).toBe(403)
    expect(sent.body).toMatchObject({ code: 'not_operator' })
  })

  it('requireAdmin admits an admin user', async () => {
    const identity = createRequestIdentity(
      stubAuth({ id: 'u1', name: 'A', email: 'a@test.local', role: 'admin' }),
    )
    const { reply, sent } = stubReply()
    const user = await identity.requireAdmin(stubRequest(), reply)
    expect(user?.status).toBe('admin')
    expect(sent.status).toBeUndefined()
  })
})
