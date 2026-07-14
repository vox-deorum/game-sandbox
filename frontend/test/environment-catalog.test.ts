import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/api/client.js', () => ({ getEnvironments: vi.fn() }))

import { getEnvironments } from '../src/api/client.js'
import {
  environmentMeta,
  loadEnvironmentCatalog,
  resetEnvironmentCatalog,
} from '../src/environmentCatalog.js'
import { flappyMeta } from './helpers/fixtures.js'

describe('environment catalog', () => {
  const meta: EnvironmentMeta = flappyMeta()

  beforeEach(() => {
    resetEnvironmentCatalog()
    vi.mocked(getEnvironments).mockReset()
  })

  it('shares an in-flight request and caches its successful result', async () => {
    let resolve: (value: EnvironmentMeta[]) => void = () => {}
    vi.mocked(getEnvironments).mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )

    const first = loadEnvironmentCatalog()
    const second = loadEnvironmentCatalog()
    expect(second).toBe(first)
    expect(getEnvironments).toHaveBeenCalledTimes(1)

    resolve([meta])
    await expect(first).resolves.toEqual([meta])
    await expect(environmentMeta(meta.env_id)).resolves.toEqual(meta)
    expect(getEnvironments).toHaveBeenCalledTimes(1)
  })

  it('forgets a rejected request so a later navigation can retry', async () => {
    vi.mocked(getEnvironments)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([meta])

    await expect(loadEnvironmentCatalog()).rejects.toThrow('offline')
    await expect(loadEnvironmentCatalog()).resolves.toEqual([meta])
    expect(getEnvironments).toHaveBeenCalledTimes(2)
  })

  it('clears successful state through the explicit test reset', async () => {
    vi.mocked(getEnvironments).mockResolvedValue([meta])
    await loadEnvironmentCatalog()
    resetEnvironmentCatalog()
    await loadEnvironmentCatalog()
    expect(getEnvironments).toHaveBeenCalledTimes(2)
  })
})
