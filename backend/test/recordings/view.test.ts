import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'

import type { AuthUser } from '../../src/auth/identity.js'
import { isBlindRecording, maskPlayers, replaceHeaderLine } from '../../src/recordings/view.js'

type Players = NonNullable<import('@game-sandbox/schema').RecordingHeader['players']>

const normal: AuthUser = {
  id: 'u1',
  name: 'One',
  email: 'u1@x',
  image: null,
  githubUsername: null,
  status: 'normal',
}
const admin: AuthUser = { ...normal, id: 'op', status: 'admin' }
const guest: AuthUser = { ...normal, id: 'g1', status: 'guest' }

const submittedPlayers: Players = {
  player_0: { kind: 'agent', label: "alice's agent", user: 'alice', submission_id: 'sub-a' },
  player_1: { kind: 'human', label: 'Bob', user: 'bob' },
}

const humanOnlyPlayers: Players = {
  player_0: { kind: 'human', label: 'Bob', user: 'bob' },
}
const builtinPlayers: Players = {
  player_0: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
}

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

describe('isBlindRecording', () => {
  it.each([
    ['operator during play', admin, 'open', submittedPlayers, false],
    ['participant during play', normal, 'open', submittedPlayers, true],
    ['anonymous during play', null, 'open', submittedPlayers, true],
    ['participant after play', normal, 'closed', submittedPlayers, false],
    ['participant without a season', normal, undefined, submittedPlayers, false],
    ['anonymous without a header', null, 'open', undefined, false],
    ['anonymous after play', null, 'closed', submittedPlayers, true],
    ['guest after play', guest, 'closed', submittedPlayers, true],
    ['anonymous human-only replay', null, 'closed', humanOnlyPlayers, true],
    ['participant without a header', normal, 'open', undefined, false],
    ['participant builtin-only replay', normal, 'open', builtinPlayers, false],
    ['participant human-only replay', normal, 'open', humanOnlyPlayers, false],
    ['guest builtin-only replay', guest, 'open', builtinPlayers, false],
  ] as const)('decides masking for %s', (_name, caller, status, players, blind) => {
    expect(isBlindRecording(caller, status, players)).toBe(blind)
  })
})

describe('maskPlayers', () => {
  it('masks other seats, keeps the submission id, and drops the reversible user id', () => {
    expect(maskPlayers(submittedPlayers, 'someone-else')).toEqual({
      player_0: { kind: 'agent', label: 'Agent', submission_id: 'sub-a' },
      player_1: { kind: 'human', label: 'Human' },
    })
    expect(maskPlayers(submittedPlayers, 'bob')).toEqual({
      player_0: { kind: 'agent', label: 'Agent', submission_id: 'sub-a' },
      player_1: { kind: 'human', label: 'Bob', user: 'bob' },
    })
    expect(submittedPlayers).toEqual({
      player_0: { kind: 'agent', label: "alice's agent", user: 'alice', submission_id: 'sub-a' },
      player_1: { kind: 'human', label: 'Bob', user: 'bob' },
    })
  })

  it.each([
    [
      'participant',
      'alice',
      false,
      {
        player_0: { kind: 'agent', label: "alice's agent", user: 'alice', submission_id: 'sub-a' },
        player_1: { kind: 'human', label: 'Human' },
      },
    ],
    [
      'guest',
      'bob',
      true,
      {
        player_0: {
          kind: 'agent',
          label: expect.stringMatching(/^Agent [0-9a-f]{6}$/),
          submission_id: 'sub-a',
        },
        player_1: { kind: 'human', label: 'Bob', user: 'bob' },
      },
    ],
  ] as const)('preserves the %s own player', (_name, caller, maskedViewer, expected) => {
    expect(maskPlayers(submittedPlayers, caller, maskedViewer)).toEqual(expected)
  })

  it('uses stable owner pseudonyms across controller kinds and display-name changes', () => {
    const players: Players = {
      ...submittedPlayers,
      player_2: { kind: 'human', label: 'Alice', user: 'alice' },
    }
    const masked = maskPlayers(players, undefined, true)
    expect(masked).toEqual({
      player_0: {
        kind: 'agent',
        label: expect.stringMatching(/^Agent [0-9a-f]{6}$/),
        submission_id: 'sub-a',
      },
      player_1: { kind: 'human', label: expect.stringMatching(/^Agent [0-9a-f]{6}$/) },
      player_2: { kind: 'human', label: expect.stringMatching(/^Agent [0-9a-f]{6}$/) },
    })
    expect(masked.player_0?.label).toBe(masked.player_2?.label)
    expect(masked.player_0?.label).not.toBe(masked.player_1?.label)
    players.player_0 = {
      kind: 'agent',
      label: 'Renamed agent',
      user: 'alice',
      submission_id: 'sub-a',
    }
    players.player_1 = { kind: 'human', label: 'Renamed human', user: 'bob' }
    expect(maskPlayers(players, 'another-viewer', true)).toEqual(masked)
  })

  it('leaves the ownerless Naive agent as-is', () => {
    const players: Players = {
      player_0: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
    }
    expect(maskPlayers(players, 'anyone').player_0).toEqual(players.player_0)
  })
})

describe('replaceHeaderLine', () => {
  it.each([
    ['whole header', ['{"old":true}\n{"tick":0}\n{"tick":1}\n']],
    ['split header', ['{"old"', ':true}\n{"tick"', ':0}\n{"tick":1}\n']],
  ])('rewrites a %s without changing state lines', async (_name, chunks) => {
    const out = await collect(replaceHeaderLine(Readable.from(chunks), '{"new":true}'))
    expect(out).toBe('{"new":true}\n{"tick":0}\n{"tick":1}\n')
  })

  it('preserves state bytes when the header chunk ends inside a UTF-8 character', async () => {
    const bytes = Buffer.from('{"old":true}\n{"chat":"✓"}\n')
    const split = bytes.indexOf(Buffer.from('✓')) + 1
    const source = Readable.from([bytes.subarray(0, split), bytes.subarray(split)])
    const chunks: Buffer[] = []
    for await (const chunk of replaceHeaderLine(source, '{"new":true}')) {
      chunks.push(Buffer.from(chunk))
    }
    expect(Buffer.concat(chunks)).toEqual(Buffer.from('{"new":true}\n{"chat":"✓"}\n'))
  })

  it('emits the masked header for a degenerate header-only recording (no trailing newline)', async () => {
    const source = Readable.from(['{"old":true}'])
    const out = await collect(replaceHeaderLine(source, '{"new":true}'))
    expect(out).toBe('{"new":true}')
  })
})
