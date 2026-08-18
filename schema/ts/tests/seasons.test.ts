import { describe, expect, it } from 'vitest'

import { normalizeSeasonDescription, seasonDescriptionViolation } from '../src/index.js'

describe('normalizeSeasonDescription', () => {
  it('collapses Windows and CR line endings to a single paragraph', () => {
    expect(normalizeSeasonDescription('first\r\nsecond\rthird\nfourth')).toBe(
      'first\nsecond\nthird\nfourth',
    )
  })

  it('coalesces Unicode line and paragraph separators to spaces', () => {
    expect(normalizeSeasonDescription('alpha\u2028beta\u2029gamma\u000bdelta\ffinal')).toBe(
      'alpha beta gamma delta final',
    )
  })

  it('trims and treats a blank description as null', () => {
    expect(normalizeSeasonDescription('  \n\t ')).toBeNull()
    expect(normalizeSeasonDescription(null)).toBeNull()
  })
})

describe('seasonDescriptionViolation', () => {
  it('rejects more than one paragraph before the length rule', () => {
    const both = normalizeSeasonDescription(`${'x'.repeat(2_001)}\n\nsecond`)
    expect(both).not.toBeNull()
    expect(seasonDescriptionViolation(both)).toBe('multiple_paragraphs')
  })

  it('rejects descriptions over the shared limit', () => {
    expect(seasonDescriptionViolation('x'.repeat(2_001))).toBe('too_long')
  })

  it('accepts a single short paragraph and a null description', () => {
    expect(seasonDescriptionViolation('A concise description.')).toBeNull()
    expect(seasonDescriptionViolation(null)).toBeNull()
  })
})
