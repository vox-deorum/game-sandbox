import { describe, expect, it } from 'vitest'

import { TiktokenCounter } from '../../src/llm/tokenizer.js'

describe('TiktokenCounter', () => {
  it('treats model special-token spellings as ordinary untrusted content', () => {
    const counter = new TiktokenCounter('cl100k_base')
    try {
      const content = '<|endoftext|> is text supplied by an agent'
      expect(
        counter.countRequest({
          model: 'small',
          messages: [{ role: 'user', content }],
        }),
      ).toBeGreaterThan(0)
      expect(
        counter.countCompletion({
          model: 'small',
          choices: [{ message: { role: 'assistant', content } }],
        }),
      ).toBeGreaterThan(0)
    } finally {
      counter.close()
    }
  })
})
