import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'

import type { AuthUser } from '../../src/auth/identity.js'
import {
  headerHasSubmittedAgent,
  isBlindRecording,
  maskPlayers,
  replaceHeaderLine,
} from '../../src/recordings/view.js'

type Players = NonNullable<import('@game-sandbox/schema').RecordingHeader['players']>

const admin: AuthUser = {
  id: 'op',
  name: 'Op',
  email: 'op@x',
  image: null,
  githubUsername: null,
  status: 'admin',
}
const normal: AuthUser = {
  id: 'u1',
  name: 'One',
  email: 'u1@x',
  image: null,
  githubUsername: null,
  status: 'normal',
}

const submittedPlayers: Players = {
  player_0: { kind: 'agent', label: "alice's agent", user: 'alice', submission_id: 'sub-a' },
  player_1: { kind: 'human', label: 'Bob', user: 'bob' },
}

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  let out = ''
  for await (const chunk of stream) {
    out += chunk.toString()
  }
  return out
}

describe('headerHasSubmittedAgent', () => {
  it('is true only when a submitted agent is present', () => {
    expect(headerHasSubmittedAgent(submittedPlayers)).toBe(true)
    expect(headerHasSubmittedAgent(undefined)).toBe(false)
    expect(
      headerHasSubmittedAgent({
        player_0: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
      }),
    ).toBe(false)
    expect(
      headerHasSubmittedAgent({ player_0: { kind: 'human', label: 'Bob', user: 'bob' } }),
    ).toBe(false)
  })
})

describe('isBlindRecording', () => {
  it('never blinds an operator', () => {
    expect(isBlindRecording(admin, 'open', submittedPlayers)).toBe(false)
  })
  it('blinds a non-operator (and an anonymous caller) on an open season with a submitted agent', () => {
    expect(isBlindRecording(normal, 'open', submittedPlayers)).toBe(true)
    expect(isBlindRecording(null, 'open', submittedPlayers)).toBe(true)
  })
  it('does not blind when the season is not open, or there is nothing to hide', () => {
    expect(isBlindRecording(normal, 'closed', submittedPlayers)).toBe(false)
    expect(isBlindRecording(normal, undefined, submittedPlayers)).toBe(false)
    expect(isBlindRecording(null, 'open', undefined)).toBe(false)
  })
})

describe('maskPlayers', () => {
  it('masks other seats, keeps the submission id, and drops the reversible user id', () => {
    const masked = maskPlayers(submittedPlayers, 'someone-else')
    expect(masked.player_0).toEqual({
      kind: 'agent',
      label: 'Agent',
      submission_id: 'sub-a',
    })
    expect(masked.player_0).not.toHaveProperty('user')
    expect(masked.player_1).toEqual({ kind: 'human', label: 'Human' })
    expect(masked.player_1).not.toHaveProperty('user')
  })

  it("leaves the viewer's own seat untouched so they can still find themselves", () => {
    const masked = maskPlayers(submittedPlayers, 'alice')
    expect(masked.player_0).toEqual(submittedPlayers.player_0)
    // The other seat is still masked.
    expect(masked.player_1).toEqual({ kind: 'human', label: 'Human' })
  })

  it('leaves the ownerless Naive agent as-is', () => {
    const players: Players = {
      player_0: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
    }
    expect(maskPlayers(players, 'anyone').player_0).toEqual(players.player_0)
  })
})

describe('replaceHeaderLine', () => {
  it('rewrites only the first line, leaving the state lines byte-for-byte', async () => {
    const source = Readable.from(['{"old":true}\n{"tick":0}\n{"tick":1}\n'])
    const out = await collect(replaceHeaderLine(source, '{"new":true}'))
    expect(out).toBe('{"new":true}\n{"tick":0}\n{"tick":1}\n')
  })

  it('handles the header arriving split across chunks', async () => {
    const source = Readable.from(['{"old"', ':true}\n{"tick"', ':0}\n'])
    const out = await collect(replaceHeaderLine(source, '{"new":true}'))
    expect(out).toBe('{"new":true}\n{"tick":0}\n')
  })

  it('emits the masked header for a degenerate header-only recording (no trailing newline)', async () => {
    const source = Readable.from(['{"old":true}'])
    const out = await collect(replaceHeaderLine(source, '{"new":true}'))
    expect(out).toBe('{"new":true}')
  })
})
