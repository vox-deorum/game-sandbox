import { describe, expect, it } from 'vitest'

import {
  classifyOutbound,
  parseCommand,
  serializeCommand,
  sessionEnvelope,
} from '../src/protocol/index.js'

describe('outbound line classification', () => {
  it('classifies a header line (no top-level kind) as a recording line', () => {
    const result = classifyOutbound('{"schema_version":1,"environment":"flappy_bird","seed":7}')
    expect(result.type).toBe('recording')
  })

  it('classifies a state line (no top-level kind) as a recording line', () => {
    const state =
      '{"schema_version":1,"tick":0,"agents":{},"timing":{"started_at":1,"duration_ms":1}}'
    expect(classifyOutbound(state).type).toBe('recording')
  })

  it('classifies a line with a top-level kind as an event envelope', () => {
    const result = classifyOutbound('{"kind":"result","ticks":3,"reason":"terminated"}')
    expect(result).toMatchObject({ type: 'envelope', kind: 'result' })
  })

  it('treats a non-object or non-JSON line as malformed', () => {
    expect(classifyOutbound('not json').type).toBe('malformed')
    expect(classifyOutbound('[1,2,3]').type).toBe('malformed')
  })
})

describe('inbound command parsing', () => {
  it('accepts input with a slot and passes the action through opaque', () => {
    const parsed = parseCommand('{"kind":"input","slot":"player_0","action":1}')
    expect(parsed).toEqual({ ok: true, command: { kind: 'input', slot: 'player_0', action: 1 } })
  })

  it('accepts pause, resume, and stop', () => {
    for (const kind of ['pause', 'resume', 'stop'] as const) {
      expect(parseCommand(`{"kind":"${kind}"}`)).toEqual({ ok: true, command: { kind } })
    }
  })

  it('rejects input without a string slot', () => {
    expect(parseCommand('{"kind":"input","action":1}').ok).toBe(false)
  })

  it('rejects an unknown kind and malformed JSON', () => {
    expect(parseCommand('{"kind":"explode"}').ok).toBe(false)
    expect(parseCommand('{"no":"kind"}').ok).toBe(false)
    expect(parseCommand('garbage').ok).toBe(false)
  })
})

describe('serialization', () => {
  it('round-trips a command through parse', () => {
    const line = serializeCommand({ kind: 'input', slot: 'player_0', action: { flap: true } })
    expect(parseCommand(line)).toEqual({
      ok: true,
      command: { kind: 'input', slot: 'player_0', action: { flap: true } },
    })
  })

  it('builds the session status frame with and without a reason', () => {
    expect(JSON.parse(sessionEnvelope('running'))).toEqual({ kind: 'session', status: 'running' })
    expect(JSON.parse(sessionEnvelope('ended', 'idle_timeout'))).toEqual({
      kind: 'session',
      status: 'ended',
      reason: 'idle_timeout',
    })
  })
})
