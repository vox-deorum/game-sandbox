import { describe, expect, it } from 'vitest'

import { sandboxResourcesForPlayers } from '../../src/driver/sandbox.js'

describe('sandboxResourcesForPlayers', () => {
  const base = { cpus: 1, memoryMb: 512, memoryPerPlayerMb: 32, scratchMb: 256 }

  it.each([
    [1, 512],
    [2, 544],
    [4, 608],
  ])('uses %i MB for %i players', (players, memoryMb) => {
    expect(sandboxResourcesForPlayers(base, players).memoryMb).toBe(memoryMb)
  })
})
