/**
 * The fetch-stubbing pattern from the api-client suite, factored out (see
 * plans/stage-04.5/testing-and-docs.md). Pair `stubFetch` with `vi.unstubAllGlobals()` in afterEach.
 */
import { vi } from 'vitest'

/** A JSON Response carrying the content-type the api client checks. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Replace the global fetch with an implementation; returns the mock for call assertions. */
export function stubFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
): ReturnType<typeof vi.fn> {
  const mock = vi.fn(impl)
  vi.stubGlobal('fetch', mock)
  return mock
}
