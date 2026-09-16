import type Docker from 'dockerode'
import { describe, expect, it } from 'vitest'

import { DockerDriver } from '../../src/driver/docker/index.js'
import { FakeDriver } from '../support/fake-driver.js'

const DRIVER_OPTIONS = {
  imageTagPrefix: 'gs-test',
  imagePolicy: 'reuse' as const,
  overlayBuildTimeoutMs: 60_000,
  llmRelay: { mode: 'host-gateway' as const },
}

describe('driver host resources', () => {
  it('reports Docker daemon CPU and memory capacity', async () => {
    const docker = {
      info: () => Promise.resolve({ NCPU: 12, MemTotal: 48 * 1024 ** 3 }),
    } as unknown as Docker
    const driver = new DockerDriver(docker, DRIVER_OPTIONS)

    await expect(driver.getHostResources()).resolves.toEqual({
      cpuCount: 12,
      memoryBytes: 48 * 1024 ** 3,
    })
  })

  it('gives the fake stable defaults and accepts an override', async () => {
    await expect(new FakeDriver().getHostResources()).resolves.toEqual({
      cpuCount: 2,
      memoryBytes: 8 * 1024 ** 3,
    })
    await expect(
      new FakeDriver({ cpuCount: 6, memoryBytes: 24 * 1024 ** 3 }).getHostResources(),
    ).resolves.toEqual({ cpuCount: 6, memoryBytes: 24 * 1024 ** 3 })
  })
})
