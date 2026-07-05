import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { SessionProcess } from '../../src/driver/index.js'
import { LiveSession } from '../../src/session/live-session.js'
import type { Storage } from '../../src/storage/index.js'
import type { SessionMode } from '../../src/storage/schema.js'
import { openSqliteStorage } from '../../src/storage/sqlite.js'
import { FakeSessionProcess } from '../support/fake-driver.js'
import { FakeSocket, flush } from '../support/harness.js'

const HEADER = '{"schema_version":1,"environment":"flappy_bird","seed":0}'
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
      externalSlots?: readonly string[]
      messaging?: { enabled: boolean; cap: number | null }
    } = {},
  ): {
    session: LiveSession
    process: FakeSessionProcess
  } {
    const process = new FakeSessionProcess()
    const session = new LiveSession({
      id: 'sess-1',
      userId: 'alice',
      envId: 'flappy_bird',
      mode,
      recordingId: 'flappy_bird-sess-1',
      createdAt: '2026-06-11T00:00:00.000Z',
      process,
      humanSlots: ['player_0'],
      externalSlots: options.externalSlots ?? (mode === 'human' ? ['player_0'] : []),
      messaging: options.messaging ?? { enabled: true, cap: 120 },
      deps: {
        storage,
        onEnd: () => {},
        log: () => {},
        idleTimeoutMs: 1_000_000,
        maxDurationMs: 1_000_000,
        killGraceMs: 10,
      },
    })
    live.push(session)
    return { session, process }
  }

  beforeEach(async () => {
    storage = await openSqliteStorage(':memory:')
    await storage.createSession({
      id: 'sess-1',
      user_id: 'alice',
      env_id: 'flappy_bird',
      mode: 'human',
      recording_id: 'flappy_bird-sess-1',
      created_at: '2026-06-11T00:00:00.000Z',
    })
  })

  afterEach(async () => {
    await Promise.all(live.splice(0).map((s) => s.finalize('stopped')))
    await storage.close()
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

  it('replays the header, latest state, and running status to a late attacher', async () => {
    const { session, process } = makeSession()
    process.emit(HEADER)
    process.emit(STATE_0)
    process.emit(STATE_1)
    await flush()

    const late = new FakeSocket()
    session.attach(late, false)
    expect(late.received[0]).toBe(HEADER)
    expect(late.received[1]).toBe(STATE_1) // the latest state, not the first
    expect(JSON.parse(late.received[2] ?? '{}')).toEqual({ kind: 'session', status: 'running' })
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
      humanSlots: ['player_0'],
      externalSlots: ['player_0'],
      messaging: { enabled: true, cap: 120 },
      deps: {
        storage,
        onEnd: () => {},
        log: () => {},
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
    it("forwards the owner's input in human mode and echoes nothing for it", async () => {
      const { session, process } = makeSession('human')
      const socket = new FakeSocket()
      const attachment = session.attach(socket, true)
      attachment.handleMessage('{"kind":"input","slot":"player_0","action":1}')
      expect(process.sent).toEqual(['{"kind":"input","slot":"player_0","action":1}'])
    })

    it("ignores a spectator's commands", async () => {
      const { session, process } = makeSession('human')
      const spectator = session.attach(new FakeSocket(), false)
      spectator.handleMessage('{"kind":"input","slot":"player_0","action":1}')
      spectator.handleMessage('{"kind":"pause"}')
      expect(process.sent).toEqual([])
    })

    it('ignores input in scripted mode and input for an unexposed slot', async () => {
      const scripted = makeSession('scripted')
      const a = scripted.session.attach(new FakeSocket(), true)
      a.handleMessage('{"kind":"input","slot":"player_0","action":1}')
      expect(scripted.process.sent).toEqual([])

      const human = makeSession('human')
      const b = human.session.attach(new FakeSocket(), true)
      b.handleMessage('{"kind":"input","slot":"player_9","action":1}')
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
      // player_0 is the human-controlled (external) slot for these human-mode sessions.
      const { session, process } = makeSession('human', { externalSlots: ['player_0'] })
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
      const { owner, spectator } = await attachOwnerAndSpectator(
        stateWith([{ from: 'player_1', to: null, text: 'table' }]),
      )
      expect(messagesIn(owner.received)).toEqual([{ from: 'player_1', to: null, text: 'table' }])
      expect(messagesIn(spectator.received)).toEqual([
        { from: 'player_1', to: null, text: 'table' },
      ])
    })

    it('shows a targeted message to a human-bound slot only to the controller', async () => {
      const { owner, spectator } = await attachOwnerAndSpectator(
        stateWith([{ from: 'player_1', to: 'player_0', text: 'psst' }]),
      )
      expect(messagesIn(owner.received)).toEqual([
        { from: 'player_1', to: 'player_0', text: 'psst' },
      ])
      expect(messagesIn(spectator.received)).toEqual([]) // withheld from the spectator live
    })

    it('withholds an agent-to-agent targeted message from everyone live', async () => {
      const { owner, spectator } = await attachOwnerAndSpectator(
        stateWith([{ from: 'player_1', to: 'player_2', text: 'secret' }]),
      )
      expect(messagesIn(owner.received)).toEqual([])
      expect(messagesIn(spectator.received)).toEqual([])
    })

    it("reflects the controller's own send back to the controller only", async () => {
      const { owner, spectator } = await attachOwnerAndSpectator(
        stateWith([{ from: 'player_0', to: 'player_1', text: 'mine' }]),
      )
      // `from` is the human-bound slot: the sender reflection shows it to the controller.
      expect(messagesIn(owner.received)).toEqual([
        { from: 'player_0', to: 'player_1', text: 'mine' },
      ])
      expect(messagesIn(spectator.received)).toEqual([])
    })

    it('treats the owner of a scripted run as a spectator', async () => {
      const { session, process } = makeSession('scripted', { externalSlots: [] })
      const owner = new FakeSocket()
      session.attach(owner, true) // owner, but a scripted run has no controller
      process.emit(HEADER)
      process.emit(stateWith([{ from: 'player_1', to: 'player_0', text: 'psst' }]))
      await flush()
      expect(messagesIn(owner.received)).toEqual([])
    })

    it('gives a late-attaching spectator the audience-filtered stashed line', async () => {
      const { session, process } = makeSession('human', { externalSlots: ['player_0'] })
      process.emit(HEADER)
      process.emit(stateWith([{ from: 'player_1', to: 'player_0', text: 'psst' }]))
      await flush()

      const late = new FakeSocket()
      session.attach(late, false) // a spectator attaching after the targeted message was stashed
      expect(messagesIn(late.received)).toEqual([]) // never leaked through the catch-up path
    })

    it('passes a state line with no messages through byte-identical', async () => {
      const { session, process } = makeSession('human', { externalSlots: ['player_0'] })
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
    const CHAT = '{"kind":"chat","slot":"player_0","to":null,"text":"hi"}'

    it('forwards an authorized chat frame to the container', () => {
      const { session, process } = makeSession('human', { externalSlots: ['player_0'] })
      const owner = session.attach(new FakeSocket(), true)
      owner.handleMessage(CHAT)
      expect(process.sent).toEqual([CHAT])
    })

    it("drops a spectator's chat frame", () => {
      const { session, process } = makeSession('human', { externalSlots: ['player_0'] })
      const spectator = session.attach(new FakeSocket(), false)
      spectator.handleMessage(CHAT)
      expect(process.sent).toEqual([])
    })

    it('drops a chat frame for a slot outside externalSlots', () => {
      const { session, process } = makeSession('human', { externalSlots: ['player_0'] })
      const owner = session.attach(new FakeSocket(), true)
      owner.handleMessage('{"kind":"chat","slot":"player_1","to":null,"text":"hi"}')
      expect(process.sent).toEqual([])
    })

    it('drops a chat frame on a scripted session', () => {
      const { session, process } = makeSession('scripted', { externalSlots: [] })
      const owner = session.attach(new FakeSocket(), true)
      owner.handleMessage(CHAT)
      expect(process.sent).toEqual([])
    })

    it('drops a chat frame when messaging is disabled', () => {
      const { session, process } = makeSession('human', {
        externalSlots: ['player_0'],
        messaging: { enabled: false, cap: 120 },
      })
      const owner = session.attach(new FakeSocket(), true)
      owner.handleMessage(CHAT)
      expect(process.sent).toEqual([])
    })

    it('drops an over-cap chat frame and forwards one at exactly the cap (code points)', () => {
      const { session, process } = makeSession('human', {
        externalSlots: ['player_0'],
        messaging: { enabled: true, cap: 3 },
      })
      const owner = session.attach(new FakeSocket(), true)
      // An emoji is one code point; three fit, four do not.
      const atCap = '{"kind":"chat","slot":"player_0","to":null,"text":"😀😀😀"}'
      const overCap = '{"kind":"chat","slot":"player_0","to":null,"text":"😀😀😀😀"}'
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
})
