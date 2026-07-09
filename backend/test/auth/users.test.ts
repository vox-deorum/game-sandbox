/**
 * The user directory (Stage 12.4): batched display-name resolution over the library-owned `user`
 * table. Vitest on `:memory:`, no Docker — real users are minted through the Better Auth harness so
 * the directory reads the exact rows the roster owns.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openTestStack, type TestStack } from '../support/harness.js'

describe('UserDirectory.namesFor', () => {
  let stack: TestStack

  beforeEach(async () => {
    stack = await openTestStack()
  })

  afterEach(async () => {
    await stack.storage.close()
  })

  it('resolves created users to their display names and omits unknown ids', async () => {
    await stack.users.headersFor('alice')
    await stack.users.headersFor('bob')
    const aliceId = stack.users.idOf('alice')
    const bobId = stack.users.idOf('bob')

    const names = await stack.userDirectory.namesFor([aliceId, bobId, 'no-such-user'])
    expect(names.get(aliceId)).toBe('alice')
    expect(names.get(bobId)).toBe('bob')
    expect(names.has('no-such-user')).toBe(false)
    expect(names.size).toBe(2)
  })

  it('returns an empty map for empty input', async () => {
    expect(await stack.userDirectory.namesFor([])).toEqual(new Map())
  })

  it('resolves duplicated input ids once', async () => {
    await stack.users.headersFor('alice')
    const aliceId = stack.users.idOf('alice')

    const names = await stack.userDirectory.namesFor([aliceId, aliceId, aliceId])
    expect(names).toEqual(new Map([[aliceId, 'alice']]))
  })

  it('treats a blank stored name as missing', async () => {
    await stack.users.headersFor('nameless')
    const id = stack.users.idOf('nameless')
    stack.sqlite.prepare("UPDATE user SET name = '' WHERE id = ?").run(id)

    expect((await stack.userDirectory.namesFor([id])).has(id)).toBe(false)
  })

  it('handles an id list larger than one IN-clause chunk', async () => {
    await stack.users.headersFor('alice')
    await stack.users.headersFor('bob')
    const aliceId = stack.users.idOf('alice')
    const bobId = stack.users.idOf('bob')

    // 600+ unique ids force at least two chunks; place one real id in each chunk's range.
    const ids = Array.from({ length: 600 }, (_, i) => `unknown-${i}`)
    ids[10] = aliceId
    ids[550] = bobId

    const names = await stack.userDirectory.namesFor(ids)
    expect(names).toEqual(
      new Map([
        [aliceId, 'alice'],
        [bobId, 'bob'],
      ]),
    )
  })
})
