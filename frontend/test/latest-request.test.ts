import { describe, expect, it } from 'vitest'

import { useLatestRequest } from '../src/composables/useLatestRequest.js'

describe('useLatestRequest', () => {
  it('makes its first request current', () => {
    const latestRequest = useLatestRequest()

    expect(latestRequest.begin()()).toBe(true)
  })

  it('makes an earlier request stale when a later request begins', () => {
    const latestRequest = useLatestRequest()
    const first = latestRequest.begin()
    const second = latestRequest.begin()

    expect(first()).toBe(false)
    expect(second()).toBe(true)
  })

  it('makes outstanding requests stale when invalidated', () => {
    const latestRequest = useLatestRequest()
    const isCurrent = latestRequest.begin()

    latestRequest.invalidate()

    expect(isCurrent()).toBe(false)
  })
})
