import { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai'
import { describe, expect, it, vi } from 'vitest'

import type { LlmChatCompletion } from '../../src/llm/types.js'
import { UpstreamCaller, upstreamRequestAllowanceMs } from '../../src/llm/upstream.js'

const success = {
  id: 'c',
  object: 'chat.completion',
  created: 1,
  model: 'm',
  choices: [],
} as LlmChatCompletion

function statusError(status: number): APIError {
  return APIError.generate(
    status,
    { error: { message: `upstream ${status}`, type: 'provider_error', code: `e${status}` } },
    undefined,
    new Headers(),
  )
}

describe('UpstreamCaller', () => {
  it.each([
    [30_000, 0, 30_000],
    [30_000, 1, 60_500],
    [30_000, 2, 91_500],
    [30_000, 6, 233_500],
  ])('bounds a %d ms timeout with %d SDK retries at %d ms', (timeoutMs, maxRetries, expected) => {
    expect(upstreamRequestAllowanceMs(timeoutMs, maxRetries)).toBe(expected)
  })

  it('passes the per-request timeout to the SDK client and measures one logical call', async () => {
    let now = 0
    const client = { create: vi.fn().mockImplementation(async () => success) }
    const caller = new UpstreamCaller({
      baseURL: 'http://unused',
      timeoutMs: 50,
      maxRetries: 2,
      client,
      now: () => (now += 17),
    })
    const result = await caller.call({ model: 'm', messages: [] })
    expect(client.create).toHaveBeenCalledOnce()
    expect(client.create).toHaveBeenCalledWith(expect.anything(), {
      timeout: 50,
    })
    expect(result.latencyMs).toBe(17)
  })

  it('settles promptly when the caller aborts while the client remains pending', async () => {
    const client = { create: vi.fn(() => new Promise<LlmChatCompletion>(() => {})) }
    const caller = new UpstreamCaller({
      baseURL: 'http://unused',
      timeoutMs: 50,
      maxRetries: 2,
      client,
    })
    const controller = new AbortController()
    const pending = caller.call({ model: 'm', messages: [] }, controller.signal)
    const reason = new Error('session ended')

    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
    expect(client.create).toHaveBeenCalledOnce()
    expect(client.create).toHaveBeenCalledWith(expect.anything(), {
      timeout: 50,
      signal: controller.signal,
    })
  })

  it('normalizes SDK client errors without retrying injected clients itself', async () => {
    const bad = { create: vi.fn().mockRejectedValue(statusError(400)) }
    const terminal = new UpstreamCaller({
      baseURL: 'http://unused',
      timeoutMs: 1,
      maxRetries: 3,
      client: bad,
    })
    await expect(terminal.call({ model: 'm', messages: [] })).rejects.toMatchObject({
      status: 400,
      code: 'e400',
    })
    expect(bad.create).toHaveBeenCalledTimes(1)

    const timeout = { create: vi.fn().mockRejectedValue(new APIConnectionTimeoutError()) }
    const caller = new UpstreamCaller({
      baseURL: 'http://unused',
      timeoutMs: 1,
      maxRetries: 1,
      client: timeout,
    })
    await expect(caller.call({ model: 'm', messages: [] })).rejects.toMatchObject({
      status: 502,
      code: 'upstream_timeout',
    })
    expect(timeout.create).toHaveBeenCalledOnce()
  })

  it.each([
    [
      'connection failure',
      () => new APIConnectionError({ message: 'offline' }),
      502,
      'upstream_connection_error',
    ],
    ['408', () => statusError(408), 408, 'e408'],
    ['409', () => statusError(409), 409, 'e409'],
    ['429', () => statusError(429), 429, 'e429'],
    ['500', () => statusError(500), 500, 'e500'],
    ['503', () => statusError(503), 503, 'e503'],
  ])('normalizes every SDK failure for %s', async (_name, makeError, status, code) => {
    const client = { create: vi.fn().mockImplementation(() => Promise.reject(makeError())) }
    const caller = new UpstreamCaller({
      baseURL: 'http://unused',
      timeoutMs: 10,
      maxRetries: 2,
      client,
    })
    await expect(caller.call({ model: 'm', messages: [] })).rejects.toMatchObject({ status, code })
    expect(client.create).toHaveBeenCalledOnce()
  })
})
