import { describe, expect, it } from 'vitest'

import { formatDate } from '../src/lib/format.js'

describe('formatDate', () => {
  it('accepts an ISO string and a Date, formatting both the same, and passes null/undefined through', () => {
    const iso = '2026-06-01T12:00:00.000Z'
    // A Date (e.g. Better Auth's already-revived createdAt) formats identically to its ISO string, so
    // callers need not round-trip a Date back through String().
    expect(formatDate(new Date(iso))).toBe(formatDate(iso))
    expect(formatDate(iso)).not.toBeNull()
    expect(formatDate(null)).toBeNull()
    expect(formatDate(undefined)).toBeNull()
  })
})
