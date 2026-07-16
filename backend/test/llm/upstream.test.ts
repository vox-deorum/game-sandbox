import { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai'
import { describe, expect, it, vi } from 'vitest'

import type { LlmChatCompletion } from '../../src/llm/types.js'
import { UpstreamCaller } from '../../src/llm/upstream.js'

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
  it('owns exact exponential retries and includes backoff in latency', async () => {
    let now = 0
    const client = {
      create: vi
        .fn()
        .mockRejectedValueOnce(statusError(429))
        .mockRejectedValueOnce(statusError(500))
        .mockResolvedValueOnce(success),
    }
    const sleeps: number[] = []
    const caller = new UpstreamCaller({
      baseURL: 'http://unused',
      timeoutMs: 50,
      maxRetries: 2,
      retryIntervalMs: 10,
      client,
      now: () => now,
      sleep: async (delay) => {
        sleeps.push(delay)
        now += delay
      },
    })
    const result = await caller.call({ model: 'm', messages: [] })
    expect(client.create).toHaveBeenCalledTimes(3)
    expect(client.create).toHaveBeenLastCalledWith(expect.anything(), {
      timeout: 50,
      maxRetries: 0,
    })
    expect(sleeps).toEqual([10, 20])
    expect(result.latencyMs).toBe(30)
  })

  it('returns a non-retryable 4xx immediately and normalizes exhausted timeouts to 502', async () => {
    const bad = { create: vi.fn().mockRejectedValue(statusError(400)) }
    const noWait = vi.fn(async () => {})
    const terminal = new UpstreamCaller({
      baseURL: 'http://unused',
      timeoutMs: 1,
      maxRetries: 3,
      retryIntervalMs: 1,
      client: bad,
      sleep: noWait,
    })
    await expect(terminal.call({ model: 'm', messages: [] })).rejects.toMatchObject({
      status: 400,
      code: 'e400',
    })
    expect(bad.create).toHaveBeenCalledTimes(1)
    expect(noWait).not.toHaveBeenCalled()

    const timeout = { create: vi.fn().mockRejectedValue(new APIConnectionTimeoutError()) }
    const exhausted = new UpstreamCaller({
      baseURL: 'http://unused',
      timeoutMs: 1,
      maxRetries: 1,
      retryIntervalMs: 1,
      client: timeout,
      sleep: noWait,
    })
    await expect(exhausted.call({ model: 'm', messages: [] })).rejects.toMatchObject({
      status: 502,
      code: 'upstream_timeout',
    })
    expect(timeout.create).toHaveBeenCalledTimes(2)
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
  ])('exhausts every retry for %s', async (_name, makeError, status, code) => {
    const client = { create: vi.fn().mockImplementation(() => Promise.reject(makeError())) }
    const sleeps: number[] = []
    const caller = new UpstreamCaller({
      baseURL: 'http://unused',
      timeoutMs: 10,
      maxRetries: 2,
      retryIntervalMs: 2,
      client,
      sleep: async (delay) => {
        sleeps.push(delay)
      },
    })
    await expect(caller.call({ model: 'm', messages: [] })).rejects.toMatchObject({ status, code })
    expect(client.create).toHaveBeenCalledTimes(3)
    expect(sleeps).toEqual([2, 4])
  })
})
