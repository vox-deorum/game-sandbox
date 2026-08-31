import { maskedAgentLabel } from '@game-sandbox/schema/accounts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuthUser } from '../../src/auth/identity.js'
import type { SessionProcess } from '../../src/driver/index.js'
import { createOfficialTickMarker, KeyRegistry } from '../../src/llm/key-registry.js'
import type { LlmGrant } from '../../src/llm/types.js'
import {
  appLogBuffer,
  configureAppLogs,
  createLogBuffer,
  resetAppLogs,
} from '../../src/logging/log-buffer.js'
import { LiveSession } from '../../src/session/live-session.js'
import type { Storage } from '../../src/storage/index.js'
import type { SessionMode } from '../../src/storage/schema.js'
import { openSqliteStorage } from '../../src/storage/sqlite.js'
import { FakeSessionProcess } from '../support/fake-driver.js'
import { FakeSocket, flush } from '../support/harness.js'

const HEADER =
  '{"schema_version":1,"environment":"flappy_bird","seed":0,"overlay_static":{"map":"village"}}'
const STATE_0 =
  '{"schema_version":1,"tick":0,"agents":{},"timing":{"started_at":1,"duration_ms":1}}'
const STATE_1 =
  '{"schema_version":1,"tick":1,"agents":{},"timing":{"started_at":2,"duration_ms":1}}'
const RESULT_TERMINATED =
  '{"kind":"result","ticks":2,"reason":"terminated","scores":{},"step_timeouts":{}}'

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await flush()
  }
}

describe('relay (LiveSession)', () => {
  let storage: Storage
  const live: LiveSession[] = []

  function makeSession(
    mode: SessionMode = 'human',
    options: {
      externalPlayers?: readonly string[]
      externalChatPlayer?: string | null
      messaging?: { enabled: boolean; cap: number | null }
      llmEnabled?: boolean
      revokeLlm?: () => Promise<void>
      llmBlockingInFlightMs?: () => number
      maxDurationMs?: number
      idleTimeoutMs?: number
      deleteLlmScope?: (scopeId: string) => void
      onEnd?: (id: string) => void
      onFinalized?: (id: string) => void
      releaseComposedImage?: () => Promise<void> | void
      diagnostic?: (line: string) => void
    } = {},
  ): {
    session: LiveSession
    process: FakeSessionProcess
  } {
    const process = new FakeSessionProcess()
    const externalPlayers = options.externalPlayers ?? (mode === 'human' ? ['player_0'] : [])
    const session = new LiveSession({
      id: 'sess-1',
      userId: 'alice',
      envId: 'flappy_bird',
      mode,
      recordingId: 'flappy_bird-sess-1',
      createdAt: '2026-06-11T00:00:00.000Z',
      process,
      externalPlayers,
      externalChatPlayer:
        options.externalChatPlayer === undefined
          ? (externalPlayers[0] ?? null)
          : options.externalChatPlayer,
      messaging: options.messaging ?? { enabled: true, cap: 120 },
      llmEnabled: options.llmEnabled,
      deps: {
        storage,
        onEnd: options.onEnd ?? (() => {}),
        onFinalized: options.onFinalized,
        diagnostic: options.diagnostic,
        idleTimeoutMs: options.idleTimeoutMs ?? 1_000_000,
        maxDurationMs: options.maxDurationMs ?? 1_000_000,
        killGraceMs: 10,
        revokeLlm: options.revokeLlm,
        llmBlockingInFlightMs: options.llmBlockingInFlightMs,
        deleteLlmScope: options.deleteLlmScope,
        releaseComposedImage: options.releaseComposedImage,
      },
    })
    live.push(session)
    return { session, process }
  }

  beforeEach(async () => {
    configureAppLogs(createLogBuffer({ sink: () => {} }))
    storage = await openSqliteStorage(':memory:')
    await storage.createSession({
      id: 'sess-1',
      user_id: 'alice',
      env_id: 'flappy_bird',
      parameters: { players: 1 },
      mode: 'human',
      recording_id: 'flappy_bird-sess-1',
      created_at: '2026-06-11T00:00:00.000Z',
    })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await Promise.all(live.splice(0).map((s) => s.finalize('stopped')))
    await storage.close()
    resetAppLogs()
  })

  it('uses the fixed live max-duration backstop without LLM timing', async () => {
    vi.useFakeTimers()
    const { process } = makeSession('scripted', { maxDurationMs: 10 })

    await vi.advanceTimersByTimeAsync(10)

    expect(process.killGraceMs).toEqual([10])
    expect(await storage.getSession('sess-1')).toMatchObject({ termination_reason: 'time_limit' })
  })

  it('keeps participant diagnostics on their dedicated stderr callback', async () => {
    const diagnostics = vi.fn()
    const { process } = makeSession('scripted', { diagnostic: diagnostics })

    process.emitDiagnostic('participant stderr')
    process.emit('not valid protocol')
    await settle()

    expect(diagnostics).toHaveBeenCalledWith('session sess-1 [container]: participant stderr')
    expect(appLogBuffer().query({ source: 'session' }).entries).toEqual([
      expect.objectContaining({
        message: 'session sess-1: dropping malformed container line: not valid protocol',
        level: 'warn',
      }),
    ])
  })

  it('does not extend the live deadline for an open background request', async () => {
    vi.useFakeTimers()
    const registry = new KeyRegistry()
    const grant = {
      kind: 'official',
      models: {},
      accountingScope: {
        key: 'official:sess-1:player_0',
        limits: { tokenBudget: 100, requestsPerMinute: 10 },
        weights: {},
        readCommittedUsage: () => ({}),
      },
      recordSink: () => {},
    } satisfies LlmGrant
    const key = registry.issueOfficial(
      'sess-1',
      grant,
      createOfficialTickMarker(),
      () => grant.recordSink,
    )
    const request = registry.authenticateRequest(key, true)
    const { process } = makeSession('scripted', {
      maxDurationMs: 10,
      llmBlockingInFlightMs: () => registry.blockingInFlightMs('sess-1'),
    })

    await vi.advanceTimersByTimeAsync(10)

    expect(process.killGraceMs).toEqual([10])
    request.release()
    await registry.revokeSession('sess-1')
  })

  it('discounts only post-start blocking LLM wait from the live max-duration backstop', async () => {
    vi.useFakeTimers()
    let inFlightMs = 7 // Setup work before LiveSession starts earns no deadline extension.
    const { process } = makeSession('scripted', {
      maxDurationMs: 10,
      llmBlockingInFlightMs: () => inFlightMs,
    })

    inFlightMs = 17
    await vi.advanceTimersByTimeAsync(10)
    expect(process.killGraceMs).toEqual([])

    await vi.advanceTimersByTimeAsync(9)
    expect(process.killGraceMs).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(process.killGraceMs).toEqual([10])
    expect(await storage.getSession('sess-1')).toMatchObject({ termination_reason: 'time_limit' })
  })

  it('fails closed when the first live LLM timing read is unavailable', async () => {
    vi.useFakeTimers()
    let available = false
    const { process } = makeSession('scripted', {
      maxDurationMs: 10,
      llmBlockingInFlightMs: () => {
        if (!available) throw new Error('proxy unavailable')
        return 100
      },
    })

    available = true
    await vi.advanceTimersByTimeAsync(10)

    expect(process.killGraceMs).toEqual([10])
  })

  it('does not credit LLM time across a failed live timing read', async () => {
    vi.useFakeTimers()
    let reads = 0
    const { process } = makeSession('scripted', {
      maxDurationMs: 10,
      llmBlockingInFlightMs: () => {
        reads += 1
        if (reads === 2) throw new Error('proxy unavailable')
        return reads === 1 ? 100 : 200
      },
    })

    await vi.advanceTimersByTimeAsync(10)

    expect(process.killGraceMs).toEqual([10])
  })

  it('broadcasts recording lines verbatim to attached sockets', async () => {
    const { session, process } = makeSession()
    const socket = new FakeSocket()
    session.attach(socket, true)

    process.emit(HEADER)
    process.emit(STATE_0)
    await flush()

    expect(socket.received).toContain(HEADER)
    expect(socket.received).toContain(STATE_0)
  })

  it('sends a human owner the header, start-gated running status, then pause', async () => {
    const { session, process } = makeSession('human')
    const owner = new FakeSocket()
    session.attach(owner, true)

    process.emit(HEADER)
    await flush()

    expect(owner.received).toEqual([
      HEADER,
      '{"kind":"session","status":"running","awaiting_start":true}',
      '{"kind":"pause"}',
    ])
  })

  it('replays the header, latest state, running status, and start pause to a late attacher', async () => {
    const { session, process } = makeSession()
    process.emit(HEADER)
    process.emit(STATE_0)
    process.emit(STATE_1)
    await flush()

    const late = new FakeSocket()
    session.attach(late, false)
    expect(late.received[0]).toBe(HEADER)
    expect(late.received[1]).toBe(STATE_1) // the latest state, not the first
    expect(JSON.parse(late.received[2] ?? '{}')).toEqual({
      kind: 'session',
      status: 'running',
      awaiting_start: true,
    })
    expect(late.received[3]).toBe('{"kind":"pause"}')
  })

  it('masks the header per socket: the owner keeps their seat, an anonymous spectator gets the hash label', async () => {
    const namedHeader = JSON.stringify({
      schema_version: 1,
      environment: 'flappy_bird',
      seed: 0,
      players: {
        player_0: { kind: 'agent', label: "alice's agent", submission_id: 'sub-a', user: 'alice' },
      },
    })
    const alice: AuthUser = {
      id: 'alice',
      name: 'alice',
      email: 'alice@test.local',
      image: null,
      githubUsername: null,
      status: 'normal',
    }
    const { session, process } = makeSession()
    const owner = new FakeSocket()
    session.attach(owner, true, alice)
    process.emit(namedHeader)
    await flush()

    // The broadcast path leaves the owner's own seat untouched, so they can still find themselves.
    expect(owner.received).toContain(namedHeader)

    // A late anonymous attacher (an omitted caller fails closed to masked) receives the buffered
    // header rewritten to the stable hash label, with the reversible user id stripped.
    const anon = new FakeSocket()
    session.attach(anon, false)
    const header = JSON.parse(anon.received[0] ?? '{}') as {
      players?: Record<string, unknown>
    }
    expect(header.players?.player_0).toEqual({
      kind: 'agent',
      label: maskedAgentLabel('alice'),
      submission_id: 'sub-a',
    })
  })

  it('clears the start gate on first resume and retains an ordinary later pause for a late attacher', async () => {
    const { session, process } = makeSession()
    const owner = session.attach(new FakeSocket(), true)
    process.emit(HEADER)
    process.emit(STATE_0)
    await flush()
    owner.handleMessage('{"kind":"resume"}')
    owner.handleMessage('{"kind":"pause"}')

    const late = new FakeSocket()
    session.attach(late, false)
    expect(late.received).toEqual([
      HEADER,
      STATE_0,
      JSON.stringify({ kind: 'session', status: 'running', awaiting_start: false }),
      '{"kind":"pause"}',
    ])
  })

  it('relays the result envelope and ignores a malformed line', async () => {
    const { session, process } = makeSession()
    const socket = new FakeSocket()
    session.attach(socket, true)

    process.emit(HEADER)
    process.emit('not-json-garbage')
    process.emit(RESULT_TERMINATED)
    await flush()

    expect(socket.received).toContain(RESULT_TERMINATED)
    expect(socket.received).not.toContain('not-json-garbage')
  })

  it('replays the complete result to an attacher racing with process finalization', async () => {
    const { session, process } = makeSession()
    const result =
      '{"kind":"result","ticks":2,"reason":"terminated","scores":{"player_0":7,"player_1":3},"step_timeouts":{}}'
    process.emit(HEADER)
    process.emit(STATE_1)
    process.emit(result)
    await flush()

    const late = new FakeSocket()
    session.attach(late, true)

    expect(late.received).toEqual([
      HEADER,
      STATE_1,
      JSON.stringify({ kind: 'session', status: 'running', awaiting_start: true }),
      '{"kind":"pause"}',
      result,
    ])
  })

  it('keeps a scripted session automatic for attached and late viewers', async () => {
    const { session, process } = makeSession('scripted')
    const attached = new FakeSocket()
    session.attach(attached, false)

    process.emit(HEADER)
    process.emit(STATE_0)
    await flush()

    expect(attached.received).toEqual([
      HEADER,
      '{"kind":"session","status":"running","awaiting_start":false}',
      STATE_0,
    ])

    const late = new FakeSocket()
    session.attach(late, false)
    expect(late.received).toEqual([
      HEADER,
      STATE_0,
      '{"kind":"session","status":"running","awaiting_start":false}',
    ])
  })

  it('relays duplicate results live while late attachers receive the first result and reason', async () => {
    const { session, process } = makeSession()
    const liveSocket = new FakeSocket()
    session.attach(liveSocket, true)
    const first =
      '{"kind":"result","ticks":2,"reason":"terminated","scores":{"player_0":7},"step_timeouts":{}}'
    const duplicate =
      '{"kind":"result","ticks":2,"reason":"stopped","scores":{"player_0":3},"step_timeouts":{}}'

    process.emit(HEADER)
    process.emit(first)
    process.emit(duplicate)
    process.finish({ code: 0, oomKilled: false })
    await settle()

    expect(liveSocket.received).toContain(first)
    expect(liveSocket.received).toContain(duplicate)

    const late = new FakeSocket()
    session.attach(late, false)
    expect(late.received).toEqual([
      HEADER,
      first,
      JSON.stringify({ kind: 'session', status: 'ended', reason: 'terminated' }),
    ])
    expect(await storage.getSession('sess-1')).toMatchObject({ termination_reason: 'terminated' })
  })

  it('does not repair an invalid first result reason from a valid duplicate', async () => {
    const { session, process } = makeSession()
    const liveSocket = new FakeSocket()
    session.attach(liveSocket, true)
    const first =
      '{"kind":"result","ticks":2,"reason":"invalid","scores":{"player_0":7},"step_timeouts":{}}'
    const duplicate =
      '{"kind":"result","ticks":2,"reason":"terminated","scores":{"player_0":3},"step_timeouts":{}}'

    process.emit(HEADER)
    process.emit(first)
    process.emit(duplicate)
    process.finish({ code: 0, oomKilled: false })
    await settle()

    expect(liveSocket.received).toContain(first)
    expect(liveSocket.received).toContain(duplicate)

    const late = new FakeSocket()
    session.attach(late, false)
    expect(late.received).toEqual([
      HEADER,
      first,
      JSON.stringify({ kind: 'session', status: 'ended', reason: 'stopped' }),
    ])
    expect(await storage.getSession('sess-1')).toMatchObject({ termination_reason: 'stopped' })
  })

  it('drains output before deriving the reason from a clean process exit', async () => {
    let releaseOutput!: () => void
    const outputGate = new Promise<void>((resolve) => {
      releaseOutput = resolve
    })
    const process: SessionProcess = {
      output: (async function* () {
        await outputGate
        yield HEADER
        yield RESULT_TERMINATED
      })(),
      diagnostics: (async function* () {})(),
      exited: Promise.resolve({ code: 0, oomKilled: false }),
      send: () => {},
      kill: async () => {},
    }
    const session = new LiveSession({
      id: 'sess-1',
      userId: 'alice',
      envId: 'flappy_bird',
      mode: 'human',
      recordingId: 'flappy_bird-sess-1',
      createdAt: '2026-06-11T00:00:00.000Z',
      process,
      externalPlayers: ['player_0'],
      externalChatPlayer: 'player_0',
      messaging: { enabled: true, cap: 120 },
      deps: {
        storage,
        onEnd: () => {},
        idleTimeoutMs: 1_000_000,
        maxDurationMs: 1_000_000,
        killGraceMs: 10,
      },
    })
    live.push(session)

    releaseOutput()
    await settle()

    expect(await storage.getSession('sess-1')).toMatchObject({
      status: 'ended',
      termination_reason: 'terminated',
    })
  })

  describe('inbound command authority', () => {
    it('drops gated commands before Start and forwards them after resume', async () => {
      const { session, process } = makeSession('human')
      const socket = new FakeSocket()
      const attachment = session.attach(socket, true)

      attachment.handleMessage('{"kind":"input","player":"player_0","action":1}')
      attachment.handleMessage('{"kind":"clock","player":"player_0","running":true}')
      attachment.handleMessage('{"kind":"chat","player":"player_0","to":null,"text":"hi"}')
      expect(process.sent).toEqual([])

      attachment.handleMessage('{"kind":"resume"}')
      process.sent.length = 0
      attachment.handleMessage('{"kind":"input","player":"player_0","action":1}')
      attachment.handleMessage('{"kind":"clock","player":"player_0","running":true}')
      attachment.handleMessage('{"kind":"chat","player":"player_0","to":null,"text":"hi"}')
      expect(process.sent).toEqual([
        '{"kind":"input","player":"player_0","action":1}',
        '{"kind":"clock","player":"player_0","running":true}',
        '{"kind":"chat","player":"player_0","to":null,"text":"hi"}',
      ])
    })

    it("ignores a spectator's commands", async () => {
      const { session, process } = makeSession('human')
      const spectator = session.attach(new FakeSocket(), false)
      spectator.handleMessage('{"kind":"input","player":"player_0","action":1}')
      spectator.handleMessage('{"kind":"pause"}')
      expect(process.sent).toEqual([])
    })

    it('ignores scripted input and a capable player the session does not expose', async () => {
      const scripted = makeSession('scripted')
      const a = scripted.session.attach(new FakeSocket(), true)
      a.handleMessage('{"kind":"input","player":"player_0","action":1}')
      expect(scripted.process.sent).toEqual([])

      const human = makeSession('human', { externalPlayers: ['player_1'] })
      const b = human.session.attach(new FakeSocket(), true)
      b.handleMessage('{"kind":"input","player":"player_0","action":1}')
      expect(human.process.sent).toEqual([])
    })

    it('forwards pause/resume from the owner and echoes them to every socket', async () => {
      const { session, process } = makeSession('human')
      const owner = new FakeSocket()
      const spectator = new FakeSocket()
      const ownerAttach = session.attach(owner, true)
      session.attach(spectator, false)

      ownerAttach.handleMessage('{"kind":"pause"}')
      expect(process.sent).toEqual(['{"kind":"pause"}'])
      expect(owner.received).toContain('{"kind":"pause"}')
      expect(spectator.received).toContain('{"kind":"pause"}')
    })

    it('tolerates an unknown kind and outright garbage without forwarding', async () => {
      const { session, process } = makeSession('human')
      const a = session.attach(new FakeSocket(), true)
      a.handleMessage('{"kind":"explode"}')
      a.handleMessage('not even json')
      expect(process.sent).toEqual([])
    })

    it("forwards the owner's clock command without echoing it", async () => {
      const { session, process } = makeSession('human')
      const owner = new FakeSocket()
      const attachment = session.attach(owner, true)
      attachment.handleMessage('{"kind":"resume"}')
      process.sent.length = 0
      attachment.handleMessage('{"kind":"clock","player":"player_0","running":true}')
      expect(process.sent).toEqual(['{"kind":"clock","player":"player_0","running":true}'])
      expect(owner.received).not.toContain('{"kind":"clock","player":"player_0","running":true}')
    })

    it('ignores a clock command from a spectator, a scripted run, and an unexposed player', async () => {
      const { session, process } = makeSession('human')
      const spectator = session.attach(new FakeSocket(), false)
      spectator.handleMessage('{"kind":"clock","player":"player_0","running":true}')
      expect(process.sent).toEqual([])

      const scripted = makeSession('scripted')
      const a = scripted.session.attach(new FakeSocket(), true)
      a.handleMessage('{"kind":"clock","player":"player_0","running":true}')
      expect(scripted.process.sent).toEqual([])

      const human = makeSession('human', { externalPlayers: ['player_1'] })
      const b = human.session.attach(new FakeSocket(), true)
      b.handleMessage('{"kind":"clock","player":"player_0","running":true}')
      expect(human.process.sent).toEqual([])
    })
  })

  // --- releasing the controls when the owner goes away ---

  describe('control release on detach', () => {
    it('tells the container the controls are released when the last owner detaches', async () => {
      const { session, process } = makeSession('human', {
        externalPlayers: ['player_0', 'player_3'],
      })
      const attachment = session.attach(new FakeSocket(), true)
      process.emit(HEADER) // the session is running before the owner walks away
      await flush()
      attachment.handleMessage('{"kind":"resume"}')
      process.sent.length = 0

      attachment.detach()
      expect(process.sent).toEqual([
        '{"kind":"clock","player":"player_0","running":false}',
        '{"kind":"clock","player":"player_3","running":false}',
      ])
    })

    it('does not release controls that have not started', async () => {
      const { session, process } = makeSession('human')
      const attachment = session.attach(new FakeSocket(), true)
      process.emit(HEADER)
      await flush()

      attachment.detach()
      expect(process.sent).toEqual([])
    })

    it('keeps the clock running while another owner socket remains', async () => {
      const { session, process } = makeSession('human')
      const first = session.attach(new FakeSocket(), true)
      session.attach(new FakeSocket(), true) // a second tab still holds the controls
      process.emit(HEADER)
      await flush()

      first.detach()
      expect(process.sent).toEqual([])
    })

    it('releases nothing for a spectator detaching or a scripted run', async () => {
      const { session, process } = makeSession('human')
      session.attach(new FakeSocket(), true)
      const spectator = session.attach(new FakeSocket(), false)
      process.emit(HEADER)
      await flush()
      spectator.detach()
      expect(process.sent).toEqual([])

      const scripted = makeSession('scripted')
      const owner = scripted.session.attach(new FakeSocket(), true)
      scripted.process.emit(HEADER)
      await flush()
      owner.detach()
      expect(scripted.process.sent).toEqual([])
    })
  })

  describe('idle ownership', () => {
    it('keeps a human session alive while an owner socket remains connected', async () => {
      vi.useFakeTimers()
      const { session, process } = makeSession('human', { idleTimeoutMs: 10 })
      const owner = session.attach(new FakeSocket(), true)

      await vi.advanceTimersByTimeAsync(10)
      expect(process.killGraceMs).toEqual([])

      owner.detach()
      await vi.advanceTimersByTimeAsync(10)
      expect(process.killGraceMs).toEqual([10])
    })

    it('arms idle only after the last of several owner sockets disconnects', async () => {
      vi.useFakeTimers()
      const { session, process } = makeSession('human', { idleTimeoutMs: 10 })
      const first = session.attach(new FakeSocket(), true)
      const second = session.attach(new FakeSocket(), true)

      first.detach()
      await vi.advanceTimersByTimeAsync(10)
      expect(process.killGraceMs).toEqual([])

      second.detach()
      await vi.advanceTimersByTimeAsync(10)
      expect(process.killGraceMs).toEqual([10])
    })

    it('does not let a spectator clear or re-arm a human session idle timeout', async () => {
      vi.useFakeTimers()
      const first = makeSession('human', { idleTimeoutMs: 10 })
      first.session.attach(new FakeSocket(), false)
      await vi.advanceTimersByTimeAsync(10)
      expect(first.process.killGraceMs).toEqual([10])

      const second = makeSession('human', { idleTimeoutMs: 10 })
      const owner = second.session.attach(new FakeSocket(), true)
      const spectator = second.session.attach(new FakeSocket(), false)
      spectator.detach()
      await vi.advanceTimersByTimeAsync(10)
      expect(second.process.killGraceMs).toEqual([])

      owner.detach()
      await vi.advanceTimersByTimeAsync(10)
      expect(second.process.killGraceMs).toEqual([10])
    })

    it('keeps scripted sessions alive for any viewer and arms only after the last viewer leaves', async () => {
      vi.useFakeTimers()
      const { session, process } = makeSession('scripted', { idleTimeoutMs: 10 })
      const first = session.attach(new FakeSocket(), true)
      const second = session.attach(new FakeSocket(), false)
      first.detach()

      await vi.advanceTimersByTimeAsync(10)
      expect(process.killGraceMs).toEqual([])

      second.detach()
      await vi.advanceTimersByTimeAsync(10)
      expect(process.killGraceMs).toEqual([10])
    })

    it('arms idle when the last owner socket throws during broadcast', async () => {
      vi.useFakeTimers()
      const { session, process } = makeSession('human', { idleTimeoutMs: 10 })
      const owner = new FakeSocket()
      const attachment = session.attach(owner, true)
      owner.breakSends()

      attachment.handleMessage('{"kind":"pause"}')
      expect(owner.closed).toBe(true)

      await vi.advanceTimersByTimeAsync(10)
      expect(process.killGraceMs).toEqual([10])
    })

    it('arms idle when backpressure drops the last owner socket', async () => {
      vi.useFakeTimers()
      const { session, process } = makeSession('human', { idleTimeoutMs: 10 })
      const owner = new FakeSocket()
      const attachment = session.attach(owner, true)
      owner.bufferedAmount = 2 * 1024 * 1024

      attachment.handleMessage('{"kind":"pause"}')
      expect(owner.closed).toBe(true)

      await vi.advanceTimersByTimeAsync(10)
      expect(process.killGraceMs).toEqual([10])
    })

    it('does not clear idle when an owner fails during catch-up', async () => {
      vi.useFakeTimers()
      const { session, process } = makeSession('human', { idleTimeoutMs: 10 })
      process.emit(HEADER)
      await vi.advanceTimersByTimeAsync(0)

      const owner = new FakeSocket()
      owner.breakSends()
      session.attach(owner, true)
      expect(owner.closed).toBe(true)

      await vi.advanceTimersByTimeAsync(10)
      expect(process.killGraceMs).toEqual([10])
    })
  })

  // --- outbound message visibility ---

  describe('outbound message visibility', () => {
    const stateWith = (messages: unknown[]): string =>
      JSON.stringify({
        schema_version: 1,
        tick: 5,
        agents: {},
        timing: { started_at: 1, duration_ms: 1 },
        messages,
      })

    /** The `messages` of the last state line a socket received (empty when absent). */
    function messagesIn(received: readonly string[]): unknown[] {
      for (let i = received.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(received[i] ?? '') as { tick?: unknown; messages?: unknown[] }
          if (typeof obj.tick === 'number') {
            return obj.messages ?? []
          }
        } catch {
          // not JSON; keep scanning
        }
      }
      return []
    }

    async function attachOwnerAndSpectator(line: string): Promise<{
      owner: FakeSocket
      spectator: FakeSocket
    }> {
      // player_0 is the human-controlled (external) player for these human-mode sessions.
      const { session, process } = makeSession('human', { externalPlayers: ['player_0'] })
      const owner = new FakeSocket()
      const spectator = new FakeSocket()
      session.attach(owner, true)
      session.attach(spectator, false)
      process.emit(HEADER) // first recording line: no messages, broadcast verbatim
      process.emit(line) // second recording line: filtered per audience
      await flush()
      return { owner, spectator }
    }

    it('shows a broadcast to every attachment', async () => {
      const line = stateWith([{ from: 'player_1', to: null, text: 'table' }])
      const { owner, spectator } = await attachOwnerAndSpectator(line)
      expect(messagesIn(owner.received)).toEqual([{ from: 'player_1', to: null, text: 'table' }])
      expect(messagesIn(spectator.received)).toEqual([
        { from: 'player_1', to: null, text: 'table' },
      ])
      // An unannotated line with nothing to filter or strip stays byte-identical for everyone.
      expect(owner.received).toContain(line)
      expect(spectator.received).toContain(line)
    })

    it('shows an annotated broadcast to the controller only when its player heard it or sent it', async () => {
      const { owner, spectator } = await attachOwnerAndSpectator(
        stateWith([
          { from: 'player_1', to: null, text: 'near', recipients: ['player_0'] },
          { from: 'player_1', to: null, text: 'far', recipients: ['player_2'] },
          { from: 'player_0', to: null, text: 'mine', recipients: ['player_2'] },
        ]),
      )
      expect(messagesIn(owner.received)).toEqual([
        { from: 'player_1', to: null, text: 'near' },
        { from: 'player_0', to: null, text: 'mine' },
      ])
      // The watcher keeps every delivered broadcast; the annotation reaches no socket at all.
      expect(messagesIn(spectator.received)).toEqual([
        { from: 'player_1', to: null, text: 'near' },
        { from: 'player_1', to: null, text: 'far' },
        { from: 'player_0', to: null, text: 'mine' },
      ])
      expect(owner.received.join('\n')).not.toContain('recipients')
      expect(spectator.received.join('\n')).not.toContain('recipients')
    })

    it('applies the annotation to the stashed catch-up line and strips it for late attachers', async () => {
      const { session, process } = makeSession('human', { externalPlayers: ['player_0'] })
      process.emit(HEADER)
      process.emit(
        stateWith([
          { from: 'player_1', to: null, text: 'near', recipients: ['player_0'] },
          { from: 'player_1', to: null, text: 'far', recipients: ['player_2'] },
        ]),
      )
      await flush()

      const lateController = new FakeSocket()
      const lateSpectator = new FakeSocket()
      session.attach(lateController, true)
      session.attach(lateSpectator, false)
      expect(messagesIn(lateController.received)).toEqual([
        { from: 'player_1', to: null, text: 'near' },
      ])
      expect(messagesIn(lateSpectator.received)).toEqual([
        { from: 'player_1', to: null, text: 'near' },
        { from: 'player_1', to: null, text: 'far' },
      ])
      expect(lateController.received.join('\n')).not.toContain('recipients')
      expect(lateSpectator.received.join('\n')).not.toContain('recipients')
    })

    it('shows targeted messages to a human spectator, while the controller sees its permitted line', async () => {
      const { owner, spectator } = await attachOwnerAndSpectator(
        stateWith([{ from: 'player_1', to: 'player_0', text: 'psst' }]),
      )
      expect(messagesIn(owner.received)).toEqual([
        { from: 'player_1', to: 'player_0', text: 'psst' },
      ])
      expect(messagesIn(spectator.received)).toEqual([
        { from: 'player_1', to: 'player_0', text: 'psst' },
      ])
    })

    it('filters an agent-to-agent targeted message only for the controller', async () => {
      const { owner, spectator } = await attachOwnerAndSpectator(
        stateWith([{ from: 'player_1', to: 'player_2', text: 'secret' }]),
      )
      expect(messagesIn(owner.received)).toEqual([])
      expect(messagesIn(spectator.received)).toEqual([
        { from: 'player_1', to: 'player_2', text: 'secret' },
      ])
    })

    it("reflects the controller's own send and keeps it visible to spectators", async () => {
      const { owner, spectator } = await attachOwnerAndSpectator(
        stateWith([{ from: 'player_0', to: 'player_1', text: 'mine' }]),
      )
      // `from` is the human-bound player: the sender reflection shows it to the controller.
      expect(messagesIn(owner.received)).toEqual([
        { from: 'player_0', to: 'player_1', text: 'mine' },
      ])
      expect(messagesIn(spectator.received)).toEqual([
        { from: 'player_0', to: 'player_1', text: 'mine' },
      ])
    })

    it('shows every delivered message to every scripted attachment', async () => {
      const { session, process } = makeSession('scripted', { externalPlayers: [] })
      const owner = new FakeSocket()
      const spectator = new FakeSocket()
      session.attach(owner, true)
      session.attach(spectator, false)
      process.emit(HEADER)
      process.emit(stateWith([{ from: 'player_1', to: 'player_0', text: 'psst' }]))
      await flush()
      expect(messagesIn(owner.received)).toEqual([
        { from: 'player_1', to: 'player_0', text: 'psst' },
      ])
      expect(messagesIn(spectator.received)).toEqual([
        { from: 'player_1', to: 'player_0', text: 'psst' },
      ])
    })

    it('gives a late-attaching human spectator the same unfiltered stashed line', async () => {
      const { session, process } = makeSession('human', { externalPlayers: ['player_0'] })
      process.emit(HEADER)
      process.emit(stateWith([{ from: 'player_1', to: 'player_0', text: 'psst' }]))
      await flush()

      const late = new FakeSocket()
      session.attach(late, false)
      expect(messagesIn(late.received)).toEqual([
        { from: 'player_1', to: 'player_0', text: 'psst' },
      ])
    })

    it('filters an unrelated targeted message from a late-attaching controller', async () => {
      const { session, process } = makeSession('human', { externalPlayers: ['player_0'] })
      process.emit(HEADER)
      process.emit(stateWith([{ from: 'player_1', to: 'player_2', text: 'secret' }]))
      await flush()

      const lateController = new FakeSocket()
      session.attach(lateController, true)
      expect(messagesIn(lateController.received)).toEqual([])
    })

    it('passes a state line with no messages through byte-identical', async () => {
      const { session, process } = makeSession('human', { externalPlayers: ['player_0'] })
      const owner = new FakeSocket()
      const spectator = new FakeSocket()
      session.attach(owner, true)
      session.attach(spectator, false)
      process.emit(HEADER)
      process.emit(STATE_1) // no messages
      await flush()
      expect(owner.received).toContain(STATE_1)
      expect(spectator.received).toContain(STATE_1)
    })
  })

  // --- inbound chat authorization ---

  describe('inbound chat authorization', () => {
    const CHAT = '{"kind":"chat","player":"player_0","to":null,"text":"hi"}'

    it('forwards an authorized chat frame to the container', () => {
      const { session, process } = makeSession('human', { externalPlayers: ['player_0'] })
      const owner = session.attach(new FakeSocket(), true)
      owner.handleMessage('{"kind":"resume"}')
      process.sent.length = 0
      owner.handleMessage(CHAT)
      expect(process.sent).toEqual([CHAT])
    })

    it('rejects a retired compose tick instead of forwarding the chat frame', () => {
      const { session, process } = makeSession('human', { externalPlayers: ['player_0'] })
      const owner = session.attach(new FakeSocket(), true)
      owner.handleMessage('{"kind":"chat","player":"player_0","tick":7,"to":null,"text":"hi"}')
      expect(process.sent).toEqual([])
    })

    it("drops a spectator's chat frame", () => {
      const { session, process } = makeSession('human', { externalPlayers: ['player_0'] })
      const spectator = session.attach(new FakeSocket(), false)
      spectator.handleMessage(CHAT)
      expect(process.sent).toEqual([])
    })

    // The designated sender is the whole chat gate: it is always drawn from externalPlayers, so a
    // player outside that set fails this check too and needs no separate case.
    it('drops a chat frame forged as a non-designated external player', () => {
      const { session, process } = makeSession('human', {
        externalPlayers: ['player_0', 'player_1'],
        externalChatPlayer: 'player_0',
      })
      const owner = session.attach(new FakeSocket(), true)
      owner.handleMessage('{"kind":"resume"}')
      process.sent.length = 0
      owner.handleMessage('{"kind":"input","player":"player_1","action":1}')
      owner.handleMessage('{"kind":"chat","player":"player_1","to":null,"text":"hi"}')
      expect(process.sent).toEqual(['{"kind":"input","player":"player_1","action":1}'])
    })

    it('drops chat when no external sender is designated', () => {
      const { session, process } = makeSession('human', {
        externalPlayers: ['player_0'],
        externalChatPlayer: null,
      })
      const owner = session.attach(new FakeSocket(), true)
      owner.handleMessage(CHAT)
      expect(process.sent).toEqual([])
    })

    it('drops a chat frame on a scripted session', () => {
      const { session, process } = makeSession('scripted', { externalPlayers: [] })
      const owner = session.attach(new FakeSocket(), true)
      owner.handleMessage(CHAT)
      expect(process.sent).toEqual([])
    })

    it('drops a chat frame when messaging is disabled', () => {
      const { session, process } = makeSession('human', {
        externalPlayers: ['player_0'],
        messaging: { enabled: false, cap: 120 },
      })
      const owner = session.attach(new FakeSocket(), true)
      owner.handleMessage(CHAT)
      expect(process.sent).toEqual([])
    })

    it('drops an over-cap chat frame and forwards one at exactly the cap (code points)', () => {
      const { session, process } = makeSession('human', {
        externalPlayers: ['player_0'],
        messaging: { enabled: true, cap: 3 },
      })
      const owner = session.attach(new FakeSocket(), true)
      owner.handleMessage('{"kind":"resume"}')
      process.sent.length = 0
      // An emoji is one code point; three fit, four do not.
      const atCap = '{"kind":"chat","player":"player_0","to":null,"text":"😀😀😀"}'
      const overCap = '{"kind":"chat","player":"player_0","to":null,"text":"😀😀😀😀"}'
      owner.handleMessage(overCap)
      expect(process.sent).toEqual([])
      owner.handleMessage(atCap)
      expect(process.sent).toEqual([atCap])
    })
  })

  it('drops a socket whose backlog crosses the backpressure limit', async () => {
    const { session, process } = makeSession()
    const slow = new FakeSocket()
    const healthy = new FakeSocket()
    session.attach(slow, true)
    session.attach(healthy, false)

    slow.bufferedAmount = 2 * 1024 * 1024 // over the 1 MiB limit
    process.emit(HEADER)
    await flush()

    expect(slow.closed).toBe(true)
    expect(healthy.received).toContain(HEADER)
  })

  it('awaits LLM revocation before process teardown and durable recording association', async () => {
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const { session, process } = makeSession('scripted', {
      llmEnabled: true,
      revokeLlm: () => barrier,
    })
    process.emit(HEADER)
    await flush()

    const stopped = session.requestStop()
    await flush()
    expect(process.killGraceMs).toEqual([])
    expect(await storage.getRecording('flappy_bird-sess-1')).toBeUndefined()

    release()
    await stopped
    expect(process.killGraceMs).toEqual([10])
    expect(await storage.getRecording('flappy_bird-sess-1')).toMatchObject({
      llm_scope_id: 'sess-1',
      llm_session_id: 'sess-1',
    })
  })

  it('associates a recording header buffered during stop before reclaiming telemetry', async () => {
    const deleted: string[] = []
    const { session, process } = makeSession('scripted', {
      llmEnabled: true,
      deleteLlmScope: (scopeId) => deleted.push(scopeId),
    })
    process.kill = async (graceMs) => {
      process.killGraceMs.push(graceMs)
      setTimeout(() => {
        process.emit(HEADER)
        process.finish({ code: 0, oomKilled: false })
      }, 0)
    }

    await session.requestStop()

    expect(await storage.getRecording('flappy_bird-sess-1')).toMatchObject({
      llm_scope_id: 'sess-1',
      llm_session_id: 'sess-1',
    })
    expect(deleted).toEqual([])
  })

  it('finishes teardown when kill throws and the output stream never closes', async () => {
    const onEnd = vi.fn()
    const onFinalized = vi.fn()
    const deleted: string[] = []
    const { session, process } = makeSession('scripted', {
      llmEnabled: true,
      deleteLlmScope: (scopeId) => deleted.push(scopeId),
      onEnd,
      onFinalized,
    })
    const socket = new FakeSocket()
    session.attach(socket, true)
    process.kill = vi.fn(async () => {
      throw new Error('container teardown failed')
    })

    await session.requestStop()

    expect(await storage.getSession('sess-1')).toMatchObject({
      status: 'ended',
      termination_reason: 'stopped',
    })
    expect(socket.received).toContain(
      JSON.stringify({ kind: 'session', status: 'ended', reason: 'stopped' }),
    )
    expect(socket.closed).toBe(true)
    expect(onEnd).toHaveBeenCalledWith('sess-1')
    expect(onFinalized).toHaveBeenCalledWith('sess-1')
    expect(deleted).toEqual([])
  })

  it('deletes a zero-recording LLM scope only after the revocation barrier', async () => {
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const deleted: string[] = []
    const { session } = makeSession('scripted', {
      llmEnabled: true,
      revokeLlm: () => barrier,
      deleteLlmScope: (scopeId) => deleted.push(scopeId),
    })

    const stopped = session.requestStop()
    await flush()
    expect(deleted).toEqual([])
    expect(await storage.getRecording('flappy_bird-sess-1')).toBeUndefined()

    release()
    await stopped
    expect(deleted).toEqual(['sess-1'])
  })

  it('releases the composed image once finalize has fully settled', async () => {
    const released: string[] = []
    const { session } = makeSession('scripted', {
      releaseComposedImage: () => {
        released.push('release')
      },
    })

    await session.requestStop()
    await settle()

    expect(released).toEqual(['release'])
  })
})
