import { describe, expect, it } from 'vitest'

import { parseCommand } from '../src/command.js'
import { serializeCommand } from '../src/protocol.js'

describe('inbound command parsing', () => {
  it('accepts input with a player and passes the action through opaque', () => {
    const parsed = parseCommand('{"kind":"input","player":"player_0","action":1}')
    expect(parsed).toEqual({ ok: true, command: { kind: 'input', player: 'player_0', action: 1 } })
  })

  it('accepts pause, resume, and stop', () => {
    for (const kind of ['pause', 'resume', 'stop'] as const) {
      expect(parseCommand(`{"kind":"${kind}"}`)).toEqual({ ok: true, command: { kind } })
    }
  })

  it('rejects input without a string player', () => {
    expect(parseCommand('{"kind":"input","action":1}').ok).toBe(false)
  })

  it('rejects input without an action field', () => {
    expect(parseCommand('{"kind":"input","player":"player_0"}').ok).toBe(false)
  })

  it('rejects an unknown kind and malformed JSON', () => {
    expect(parseCommand('{"kind":"explode"}').ok).toBe(false)
    expect(parseCommand('{"no":"kind"}').ok).toBe(false)
    expect(parseCommand('garbage').ok).toBe(false)
  })

  it('accepts a chat command with a targeted or null recipient', () => {
    expect(parseCommand('{"kind":"chat","player":"player_0","to":"player_2","text":"hi"}')).toEqual(
      {
        ok: true,
        command: { kind: 'chat', player: 'player_0', to: 'player_2', text: 'hi' },
      },
    )
    expect(parseCommand('{"kind":"chat","player":"player_0","to":null,"text":"table!"}')).toEqual({
      ok: true,
      command: { kind: 'chat', player: 'player_0', to: null, text: 'table!' },
    })
  })

  it('rejects a chat command with a bad player, to, or text', () => {
    expect(parseCommand('{"kind":"chat","to":null,"text":"hi"}').ok).toBe(false)
    expect(parseCommand('{"kind":"chat","player":"player_0","to":5,"text":"hi"}').ok).toBe(false)
    expect(parseCommand('{"kind":"chat","player":"player_0","to":null,"text":42}').ok).toBe(false)
  })

  it('rejects a chat command with a missing recipient', () => {
    expect(parseCommand('{"kind":"chat","player":"player_0","text":"hi"}').ok).toBe(false)
  })

  it('ignores an unrecognized field on non-chat commands', () => {
    expect(parseCommand('{"kind":"input","player":"player_0","action":1,"extra":"field"}')).toEqual(
      { ok: true, command: { kind: 'input', player: 'player_0', action: 1 } },
    )
    expect(parseCommand('{"kind":"pause","extra":"field"}')).toEqual({
      ok: true,
      command: { kind: 'pause' },
    })
  })

  it('rejects an unrecognized field on a chat command', () => {
    expect(
      parseCommand('{"kind":"chat","player":"player_0","tick":7,"to":null,"text":"hi"}'),
    ).toEqual({ ok: false, reason: 'chat command has an invalid shape' })
  })

  it('rejects a non-object and an array', () => {
    expect(parseCommand('null').ok).toBe(false)
    expect(parseCommand('42').ok).toBe(false)
    expect(parseCommand('[1,2,3]').ok).toBe(false)
  })

  it('round-trips a command through parse', () => {
    const line = serializeCommand({ kind: 'input', player: 'player_0', action: { flap: true } })
    expect(parseCommand(line)).toEqual({
      ok: true,
      command: { kind: 'input', player: 'player_0', action: { flap: true } },
    })
  })
})
