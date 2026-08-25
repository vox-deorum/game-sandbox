/**
 * The one place the backend decides who a request belongs to. A request carries a Better Auth session
 * cookie (sent automatically on same-origin fetches, WebSocket upgrades, and native download
 * navigations); {@link createRequestIdentity} resolves it to an {@link AuthUser} once per request and
 * exposes the authorization guards every route states its requirement against. Nothing else in the
 * backend may invent its own notion of identity.
 *
 * Authorization is expressed as a single derived {@link UserStatus} (`pending` | `normal` | `guest` |
 * `admin`), computed from the user's Better Auth `role` by {@link deriveStatus}. Ban is orthogonal:
 * Better Auth revokes a banned user's sessions and blocks their sign-in, so a banned user never
 * carries a live session; {@link RequestIdentity.resolveUser} treats one as anonymous purely as
 * defense in depth.
 */
import { deriveStatus, type UserStatus } from '@game-sandbox/schema/accounts'
import type { FastifyReply, FastifyRequest } from 'fastify'

import type { Auth } from './auth.js'

// The role->status derivation is shared with the frontend roster; re-export it here so backend callers
// (and the identity unit test) keep resolving it through the identity seam.
export { deriveStatus, type UserStatus }

/** The resolved acting user: the session user plus its derived {@link UserStatus}. */
export interface AuthUser {
  id: string
  name: string
  email: string
  image: string | null
  githubUsername: string | null
  status: UserStatus
}

/**
 * The request identity seam: resolve the acting user from the session cookie, and the three guards
 * routes gate on. The guards send their error reply and return `undefined`, matching the early-return
 * style the handlers use (`if (user === undefined) return`).
 */
export interface RequestIdentity {
  /** The acting user for a request, or `null` when anonymous (no cookie, or a banned/expired session). */
  resolveUser(request: FastifyRequest): Promise<AuthUser | null>
  /** Require any signed-in user; `401 auth_required` when anonymous. */
  requireUser(request: FastifyRequest, reply: FastifyReply): Promise<AuthUser | undefined>
  /** Require a player (`guest`, `normal`, or `admin`); `403 not_active` for a pending user. */
  requirePlayer(request: FastifyRequest, reply: FastifyReply): Promise<AuthUser | undefined>
  /** Require an active (`normal` or `admin`) user; `403 not_active` for a pending or guest user. */
  requireActive(request: FastifyRequest, reply: FastifyReply): Promise<AuthUser | undefined>
  /** Require an `admin` user; `403 not_operator` otherwise. */
  requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<AuthUser | undefined>
}

/**
 * Whether a caller may see real user names. Only signed-in non-guest statuses (`pending`, `normal`,
 * `admin`) see them; anonymous and guest callers are masked everywhere, on the API and the UI.
 */
export function namesVisible(caller: AuthUser | null): boolean {
  return caller !== null && caller.status !== 'guest'
}

/** Build a Fetch `Headers` carrying the request's cookie, the only header the session lookup needs. */
function cookieHeaders(request: FastifyRequest): Headers {
  const headers = new Headers()
  const cookie = request.headers.cookie
  if (typeof cookie === 'string') {
    headers.set('cookie', cookie)
  }
  return headers
}

/**
 * Build the request-identity seam over a Better Auth instance. The session lookup is memoized per
 * request on a `WeakMap` keyed by the request object, so a route that both guards and personalizes
 * (e.g. `watch-agents`) resolves the session only once.
 */
export function createRequestIdentity(auth: Auth): RequestIdentity {
  const cache = new WeakMap<FastifyRequest, Promise<AuthUser | null>>()

  async function lookup(request: FastifyRequest): Promise<AuthUser | null> {
    const session = await auth.api.getSession({ headers: cookieHeaders(request) })
    if (session === null) {
      return null
    }
    const user = session.user
    // Defense in depth: Better Auth has already revoked a banned user's sessions, so this is normally
    // unreachable, but a banned user is treated as anonymous rather than trusted.
    if (user.banned === true) {
      return null
    }
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image ?? null,
      githubUsername: (user as { githubUsername?: string | null }).githubUsername ?? null,
      status: deriveStatus(user.role),
    }
  }

  function resolveUser(request: FastifyRequest): Promise<AuthUser | null> {
    const existing = cache.get(request)
    if (existing !== undefined) {
      return existing
    }
    const promise = lookup(request)
    cache.set(request, promise)
    return promise
  }

  async function requireUser(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthUser | undefined> {
    const user = await resolveUser(request)
    if (user === null) {
      await reply.code(401).send({ error: 'authentication required', code: 'auth_required' })
      return undefined
    }
    return user
  }

  async function requirePlayer(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthUser | undefined> {
    const user = await requireUser(request, reply)
    if (user === undefined) {
      return undefined
    }
    if (user.status === 'pending') {
      await reply.code(403).send({ error: 'your account is awaiting approval', code: 'not_active' })
      return undefined
    }
    return user
  }

  async function requireActive(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthUser | undefined> {
    const user = await requireUser(request, reply)
    if (user === undefined) {
      return undefined
    }
    if (user.status !== 'normal' && user.status !== 'admin') {
      await reply.code(403).send({ error: 'your account is awaiting approval', code: 'not_active' })
      return undefined
    }
    return user
  }

  async function requireAdmin(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthUser | undefined> {
    const user = await requireUser(request, reply)
    if (user === undefined) {
      return undefined
    }
    if (user.status !== 'admin') {
      await reply.code(403).send({ error: 'operator access required', code: 'not_operator' })
      return undefined
    }
    return user
  }

  return { resolveUser, requireUser, requirePlayer, requireActive, requireAdmin }
}
