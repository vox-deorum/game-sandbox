import { describe, expect, it } from 'vitest'

import { gameWatchdogMs } from '../../src/workflow/workflow-runner.js'

describe('gameWatchdogMs', () => {
  it('scales the resolved episode limit by players', () => {
    expect(gameWatchdogMs(100, 4, 10)).toBe(410)
    expect(gameWatchdogMs(25, 2, 10)).toBe(60)
  })
})
