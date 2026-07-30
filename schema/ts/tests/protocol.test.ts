import { describe, expect, it } from 'vitest'

import {
  classifyOutbound,
  codePointLength,
  serializeCommand,
  sessionEnvelope,
} from '../src/index.js'

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

  it('carries the parsed object on a recording line so the relay need not parse it again', () => {
    const line = classifyOutbound(
      '{"schema_version":1,"tick":2,"agents":{},"timing":{"started_at":1,"duration_ms":1},"messages":[{"from":"player_0","to":null,"text":"hi"}]}',
    )
    expect(line.type).toBe('recording')
    if (line.type === 'recording') {
      expect(line.value.messages).toEqual([{ from: 'player_0', to: null, text: 'hi' }])
    }
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

describe('code-point counter', () => {
  it('counts an astral-plane character as one, matching Python len', () => {
    expect(codePointLength('😀')).toBe(1)
    expect(codePointLength('a😀b')).toBe(3)
    expect(codePointLength('')).toBe(0)
    expect(codePointLength('hello')).toBe(5)
  })
})

describe('serialization', () => {
  it('pins the exact chat JSON both languages speak', () => {
    // The same literal string the Python live_io test parses into a queued frame.
    const line = serializeCommand({
      kind: 'chat',
      player: 'player_0',
      to: null,
      text: 'hi',
    })
    expect(line).toBe('{"kind":"chat","player":"player_0","to":null,"text":"hi"}')
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
