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

  function makeSession(mode: SessionMode = 'human'): {
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
