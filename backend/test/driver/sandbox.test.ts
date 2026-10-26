import { describe, expect, it } from 'vitest'

import {
  buildSandboxProfile,
  sandboxResourcesForPlayers,
  sandboxResourcesForSeason,
} from '../../src/driver/sandbox.js'

const base = { cpus: 1, memoryMb: 512, memoryPerPlayerMb: 32, scratchMb: 256, pids: 512 }

describe('sandboxResourcesForPlayers', () => {
  it.each([
    [1, 512],
    [2, 544],
    [4, 608],
  ])('uses %i MB for %i players', (players, memoryMb) => {
    expect(sandboxResourcesForPlayers(base, players).memoryMb).toBe(memoryMb)
  })
})

describe('sandboxResourcesForSeason', () => {
  it('keeps the deployment defaults and no GPU when the season sets nothing', () => {
    expect(sandboxResourcesForSeason(base, undefined)).toEqual({ ...base, gpu: false })
    expect(sandboxResourcesForSeason(base, {})).toEqual({ ...base, gpu: false })
  })

  it('replaces CPUs and memory, and the per-player increment still applies on top', () => {
    const season = sandboxResourcesForSeason(base, { cpus: 4, memory_mb: 4096, gpu: true })
    expect(season).toMatchObject({ cpus: 4, memoryMb: 4096, gpu: true })
    expect(sandboxResourcesForPlayers(season, 2)).toMatchObject({ memoryMb: 4128, gpu: true })
  })
})

describe('buildSandboxProfile', () => {
  it('asks for a GPU only when the resources do, with the caller busy policy', () => {
    expect(buildSandboxProfile(base, []).gpu).toBeUndefined()
    expect(buildSandboxProfile({ ...base, gpu: true }, []).gpu).toEqual({ whenBusy: 'wait' })
    expect(buildSandboxProfile({ ...base, gpu: true }, [], 'none', 'fail').gpu).toEqual({
      whenBusy: 'fail',
    })
  })
})
