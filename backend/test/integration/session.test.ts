/**
 * The headline exit criterion, end to end: a scripted WebSocket client (standing in for the
 * browser) plays Flappy Bird through the real backend and a real sandboxed container. It receives
 * schema-valid states at the pace cadence, its flap inputs visibly change the game versus an
 * input-less run, and the recording lands on the shared volume and round-trips through the schema
 * reader. A second test proves a short human-player timeout keeps the session advancing on noop.
 */
import { readRecording } from '@game-sandbox/schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type Stack, startSession, startStack, stopSession, waitForEnded } from './support/stack.js'
import { WsClient } from './support/ws-client.js'

const SEED = 7
const COLLECT_TARGET = 10

interface Overlay {
  player?: { y?: number }
}

interface PlayResult {
  id: string
  altitudes: number[]
  intervals: number[]
}

/** Play one human session, optionally flapping, and collect the altitude trajectory and cadence. */
async function play(
  stack: Stack,
  opts: { user: string; flap: boolean; humanTimeoutMs?: number },
): Promise<PlayResult> {
  const { id, wsPath } = await startSession(
    stack,
    {
      env_id: 'flappy_bird',
      seats: { seat_0: { kind: 'human' } },
      seed: SEED,
      ...(opts.humanTimeoutMs ? { human_timeout_ms: opts.humanTimeoutMs } : {}),
    },
    opts.user,
  )
  const ws = await WsClient.connect(
    `${stack.wsBase}${wsPath}`,
    (await stack.users.headersFor(opts.user)).cookie,
  )
  await ws.waitFor(() => ws.envelopes('session').some((e) => e.status === 'running'), 30_000)
  ws.send({ kind: 'resume' })

  const flapTimer = opts.flap
    ? setInterval(() => ws.send({ kind: 'input', player: 'player_0', action: 1 }), 20)
    : undefined
  // Collect a stream of states, stopping early if the episode terminates on its own.
  try {
    await ws.waitFor(
      () =>
        ws.states().length >= COLLECT_TARGET ||
        ws.envelopes('session').some((e) => e.status === 'ended'),
      4_000,
    )
  } finally {
    if (flapTimer) {
      clearInterval(flapTimer)
    }
  }

  const states = ws.states()
  const altitudes = states
    .map((s) => (s.overlay as Overlay | undefined)?.player?.y)
    .filter((y): y is number => typeof y === 'number')
  const times = states.map((s) => s.at)
  const intervals = times.slice(1).map((t, i) => t - (times[i] ?? t))

  await stopSession(stack, id, opts.user)
  await waitForEnded(stack, id, 10_000)
  ws.close()
  return { id, altitudes, intervals }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

describe('live session over WebSocket', () => {
  let stack: Stack

  beforeEach(async () => {
    stack = await startStack()
  })

  afterEach(async () => {
    await stack.close()
  })

  it('streams schema-valid states at cadence, flaps affect the game, and the recording round-trips', async () => {
    const flapping = await play(stack, { user: 'alice', flap: true })
    const idle = await play(stack, { user: 'bob', flap: false })

    // States validated through the schema guards on the way in (WsClient.states throws otherwise).
    expect(flapping.altitudes.length).toBeGreaterThan(3)
    expect(idle.altitudes.length).toBeGreaterThan(3)

    // Flapping demonstrably diverges from the input-less run from the same seed.
    const common = Math.min(flapping.altitudes.length, idle.altitudes.length)
    const flapY = flapping.altitudes.slice(0, common)
    const idleY = idle.altitudes.slice(0, common)
    expect(flapY).not.toEqual(idleY)
    const maxDiff = Math.max(...flapY.map((y, i) => Math.abs(y - (idleY[i] ?? 0))))
    expect(maxDiff).toBeGreaterThan(10)

    // Cadence: ~50 ms pace, asserted with generous tolerance for CI-runner jitter.
    if (flapping.intervals.length >= 8) {
      const med = median(flapping.intervals)
      expect(med).toBeGreaterThan(15)
      expect(med).toBeLessThan(250)
    }

    // The recording is on the shared volume and round-trips through the schema reader.
    const response = await fetch(`${stack.httpBase}/api/recordings/flappy_bird-${flapping.id}`)
    expect(response.status).toBe(200)
    const parsed = readRecording(await response.text())
    expect(parsed.header.environment).toBe('flappy_bird')
    expect(parsed.states.length).toBeGreaterThan(3)
  })

  it('keeps advancing on the noop fallback under a short human-player timeout', async () => {
    const { id, wsPath } = await startSession(
      stack,
      {
        env_id: 'flappy_bird',
        seats: { seat_0: { kind: 'human' } },
        seed: SEED,
        human_timeout_ms: 100,
      },
      'carol',
    )
    const ws = await WsClient.connect(
      `${stack.wsBase}${wsPath}`,
      (await stack.users.headersFor('carol')).cookie,
    )
    await ws.waitFor(() => ws.envelopes('session').some((e) => e.status === 'running'), 30_000)
    ws.send({ kind: 'resume' })

    // No input is ever sent; the session must keep stepping rather than stall.
    await ws.waitFor(() => ws.states().length >= 6, 3_000)
    expect(ws.states().length).toBeGreaterThanOrEqual(6)

    await stopSession(stack, id, 'carol')
    await waitForEnded(stack, id, 10_000)
    ws.close()
  })
})
