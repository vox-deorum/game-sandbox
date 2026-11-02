import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'

import type { LlmChatCompletion, LlmChatRequest } from '../../src/llm/types.js'
import { UpstreamCaller, upstreamRequestAllowanceMs } from '../../src/llm/upstream.js'
import { createLlmUpstreamStub } from '../support/llm-upstream.js'

const success = {
  id: 'c',
  object: 'chat.completion',
  created: 1,
  model: 'm',
  choices: [],
} as LlmChatCompletion

async function serve(route: (request: FastifyRequest, reply: FastifyReply) => unknown) {
  const app = Fastify({ forceCloseConnections: true })
  app.post('/v1/chat/completions', route)
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  return { app, baseURL: `${address}/v1` }
}

describe('UpstreamCaller', () => {
  it.each([
    [undefined, undefined],
    ['synthetic-upstream-key', 'Bearer synthetic-upstream-key'],
  ])('forwards the payload and optional credential %s across HTTP', async (apiKey, authorization) => {
    let now = 100
    const observed: unknown[] = []
    const { app, baseURL } = await serve((request) => {
      observed.push({ authorization: request.headers.authorization, body: request.body })
      now = 117
      return success
    })
    try {
      const caller = new UpstreamCaller({
        baseURL,
        apiKey,
        timeoutMs: 1_000,
        maxRetries: 0,
        now: () => now,
      })
      const payload: LlmChatRequest = {
        model: 'm',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 7,
        temperature: 0.25,
      }
      await expect(caller.call(payload)).resolves.toEqual({ completion: success, latencyMs: 17 })
      expect(observed).toEqual([
        {
          authorization,
          body: {
            model: 'm',
            messages: [{ role: 'user', content: 'hello' }],
            max_tokens: 7,
            temperature: 0.25,
          },
        },
      ])
    } finally {
      await app.close()
    }
  })

  it('allows every attempt timeout and grows finitely when retries are enabled', () => {
    expect(upstreamRequestAllowanceMs(30_000, 0)).toBe(30_000)
    const oneRetry = upstreamRequestAllowanceMs(30_000, 1)
    const twoRetries = upstreamRequestAllowanceMs(30_000, 2)
    expect(Number.isFinite(oneRetry)).toBe(true)
    expect(Number.isFinite(twoRetries)).toBe(true)
    expect(oneRetry).toBeGreaterThanOrEqual(60_000)
    expect(twoRetries).toBeGreaterThanOrEqual(90_000)
    expect(twoRetries).toBeGreaterThan(oneRetry)
  })

  it.each([
    ['connection failure', 'upstream_connection_error'],
    ['timeout', 'upstream_timeout'],
  ])('bounds SDK attempts and normalizes a real %s', async (failure, code) => {
    let attempts = 0
    const { app, baseURL } = await serve((request, reply) => {
      attempts++
      reply.hijack()
      if (failure === 'connection failure') request.raw.socket.destroy()
    })
    try {
      const caller = new UpstreamCaller({ baseURL, timeoutMs: 100, maxRetries: 1 })
      await expect(caller.call({ model: 'm', messages: [] })).rejects.toMatchObject({
        status: 502,
        envelope: { error: { code, type: 'upstream_error', message: expect.stringMatching(/\S/) } },
      })
      expect(attempts).toBe(2)
    } finally {
      await app.close()
    }
  })

  it('forwards cancellation to a noncooperating client and settles even if it never responds', async () => {
    let receivedSignal: AbortSignal | undefined | null
    const caller = new UpstreamCaller({
      baseURL: 'http://unused',
      timeoutMs: 50,
      maxRetries: 2,
      client: {
        create: (_request, options) => {
          receivedSignal = options.signal
          return new Promise<LlmChatCompletion>(() => {})
        },
      },
    })
    const controller = new AbortController()
    const pending = caller.call({ model: 'm', messages: [] }, controller.signal)
    expect(receivedSignal).toBe(controller.signal)
    const reason = new Error('session ended')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    receivedSignal = undefined
    await expect(caller.call({ model: 'm', messages: [] }, controller.signal)).rejects.toBe(reason)
    expect(receivedSignal).toBeUndefined()
  })

  it.each([
    [408, true, 2],
    [409, true, 2],
    [429, true, 2],
    [500, true, 2],
    [503, true, 2],
    [503, false, 3],
    [400, false, 1],
  ] as const)('handles HTTP %d with recovery %s in %d attempts', async (status, recover, expectedAttempts) => {
    let attempts = 0
    const { app, baseURL } = await serve((_request, reply) => {
      attempts++
      if (recover && attempts === 2) return success
      return reply
        .header('retry-after-ms', '1')
        .code(status)
        .send({
          error: { message: `upstream ${status}`, type: 'provider_error', code: `e${status}` },
        })
    })
    try {
      const caller = new UpstreamCaller({ baseURL, timeoutMs: 1_000, maxRetries: 2 })
      if (recover) {
        await expect(caller.call({ model: 'm', messages: [] })).resolves.toMatchObject({
          completion: success,
        })
      } else {
        await expect(caller.call({ model: 'm', messages: [] })).rejects.toMatchObject({
          status,
          envelope: {
            error: { message: `upstream ${status}`, type: 'provider_error', code: `e${status}` },
          },
        })
      }
      expect(attempts).toBe(expectedAttempts)
    } finally {
      await app.close()
    }
  })

  it('lists the upstream models, and reports a refusal with the provider status', async () => {
    const stub = createLlmUpstreamStub()
    const address = await stub.listen()
    try {
      const caller = (baseURL: string) =>
        new UpstreamCaller({ baseURL, timeoutMs: 1_000, maxRetries: 0 })
      expect(await caller(`${address}/v1`).listModels()).toEqual([
        'provider-large',
        'provider-small',
      ])
      await expect(caller(`${address}/missing`).listModels()).rejects.toMatchObject({ status: 404 })
    } finally {
      await stub.close()
    }
  })
})
