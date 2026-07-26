import { describe, expect, it } from 'vitest'

import { gameWatchdogMs } from '../../src/workflow/workflow-runner.js'

const meta = { episode_limit_ms: 100 } as Parameters<typeof gameWatchdogMs>[0]

describe('gameWatchdogMs', () => {
  it('scales the effective episode limit by players and honors the frozen override', () => {
    expect(gameWatchdogMs(meta, undefined, 4, 10)).toBe(410)
    expect(gameWatchdogMs(meta, { episode_timeout_ms: 25 }, 2, 10)).toBe(60)
  })

  it('rejects nonpositive and overflowing arithmetic', () => {
    expect(() => gameWatchdogMs(meta, undefined, 0, 10)).toThrow(/positive safe integer/)
    expect(() => gameWatchdogMs(meta, undefined, Number.MAX_SAFE_INTEGER, 10)).toThrow(
      /positive safe integer/,
    )
  })
})
