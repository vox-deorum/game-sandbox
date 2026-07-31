/**
 * Mount the Better Auth server on the Fastify app as one catch-all route for GET and POST on
 * `/api/auth/*`. The handler translates the Fastify request into a Fetch `Request`, calls
 * `auth.handler`, and copies the status, headers, and body back onto the reply.
 *
 * Two body-parsing hazards are handled inside this encapsulated plugin, so the app's global JSON
 * parsing is untouched (Fastify plugins are encapsulated):
 *
 * - Better Auth must see the exact request bytes, but the app's global JSON parser would consume and
 *   re-serialize the body first. A scoped `application/json` parser keeps the raw string.
 * - That default parser also 400s an empty body, which would break the empty-bodied sign-out POST.
 *   The scoped parser tolerates an empty body (passed through as `undefined`).
 *
 * The `Set-Cookie` copy is deliberate: `Headers.forEach` comma-joins multiple `Set-Cookie` values
 * into one corrupt header, so the response's set-cookies are copied via `getSetCookie()` as an array
 * and every other header is copied with `forEach`.
 *
 * The Fetch `Request` is built over the configured public origin, not the client-supplied `Host`
 * header. Better Auth uses the request URL only for path routing (its origin/CSRF checks read the
 * trusted origins), so a trusted base keeps routing stable and avoids a spoofed, absent, or malformed
 * `Host` producing a bogus base or throwing inside the handler.
 */

import { fromNodeHeaders } from 'better-auth/node'
import type { FastifyInstance } from 'fastify'

import type { Auth } from './auth.js'
import type { RequestIdentity } from './identity.js'

export interface AuthRouteDeps {
  auth: Auth
  identity: RequestIdentity
}

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): Promise<void> {
  // The frontend's single source for who-am-I and what-may-I-do: the session user and its derived
  // status, or a null user for an anonymous request. Anonymous is a 200 (not a 401), so the app shell
  // renders its signed-out state from a successful fetch. The frontend derives its capabilities from
  // `status`; the backend guards below are the real authority.
  app.get('/api/me', async (request) => {
    const user = await deps.identity.resolveUser(request)
    if (user === null) {
      return { user: null }
    }
    return {
      // An explicit wire projection, not `return { user }`: the client contract is exactly these
      // fields, so a field later added to AuthUser for backend use is never auto-exposed here.
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        github_username: user.githubUsername ?? null,
        status: user.status,
      },
    }
  })

  // The configured public origin. `createAuth` always sets `baseURL`.
  const baseUrl = deps.auth.options.baseURL
  if (baseUrl === undefined) {
    throw new Error('Better Auth requires a configured base URL')
  }
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (_request, body, done) => {
        done(null, body)
      },
    )

    scope.route({
      method: ['GET', 'POST'],
      url: '/api/auth/*',
      handler: async (request, reply) => {
        const url = new URL(request.url, baseUrl)
        const body =
          typeof request.body === 'string' && request.body !== '' ? request.body : undefined
        const response = await deps.auth.handler(
          new Request(url, {
            method: request.method,
            headers: fromNodeHeaders(request.headers),
            body,
          }),
        )

        reply.status(response.status)
        response.headers.forEach((value, key) => {
          if (key.toLowerCase() !== 'set-cookie') {
            reply.header(key, value)
          }
        })
        const setCookies = response.headers.getSetCookie()
        if (setCookies.length > 0) {
          reply.header('set-cookie', setCookies)
        }
        return reply.send(response.body === null ? null : await response.text())
      },
    })
  })
}
