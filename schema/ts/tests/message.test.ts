import { describe, expect, it } from 'vitest'

import { type MessageIdentity, messageKey } from '../src/message.js'

const MESSAGE: MessageIdentity = {
  tick: 7,
  from: 'player_0',
  to: null,
  text: 'meet at the inn',
}

describe('messageKey', () => {
  it('serializes the canonical identity tuple', () => {
    expect(messageKey(MESSAGE)).toBe('[7,"player_0",null,"meet at the inn"]')
  })

  it('distinguishes every identity field', () => {
    const keys = [
      messageKey(MESSAGE),
      messageKey({ ...MESSAGE, tick: 8 }),
      messageKey({ ...MESSAGE, from: 'player_1' }),
      messageKey({ ...MESSAGE, to: 'player_2' }),
      messageKey({ ...MESSAGE, text: 'meet at the well' }),
    ]
    expect(new Set(keys).size).toBe(keys.length)
  })
})
