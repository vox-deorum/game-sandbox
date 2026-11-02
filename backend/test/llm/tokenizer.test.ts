import { describe, expect, it } from 'vitest'

import { TiktokenCounter } from '../../src/llm/tokenizer.js'

// Expected counts are literal results from a one-time tiktoken 1.0.22 reference run over the exact
// JSON texts produced by these objects. They stay fixed so an encoding or tokenizer upgrade shows up
// as a reviewable test change.
const ORDINARY_REQUEST = { messages: [{ role: 'user', content: 'hello' }] }
const SPECIAL_REQUEST = { messages: [{ role: 'user', content: '<|endoftext|>' }] }
const SPECIAL_COMPLETION = {
  choices: [{ message: { role: 'assistant', content: '<|endoftext|>' } }],
}

describe('TiktokenCounter', () => {
  it.each([
    ['cl100k_base', 12, 18, 20],
    ['p50k_base', 13, 19, 22],
  ] as const)('%s counts the reviewed request and completion vectors', (encoding, ordinaryRequest, specialRequest, specialCompletion) => {
    const counter = new TiktokenCounter(encoding)
    try {
      expect(counter.countRequest(ORDINARY_REQUEST)).toBe(ordinaryRequest)
      expect(counter.countRequest(SPECIAL_REQUEST)).toBe(specialRequest)
      expect(counter.countCompletion(SPECIAL_COMPLETION)).toBe(specialCompletion)
    } finally {
      counter.close()
    }
  })
})
