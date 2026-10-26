import { describe, expect, it } from 'vitest'
import { variantImageTagPrefix } from '../../../src/driver/docker/image.js'
import { containerCreateOptions } from '../../../src/driver/docker/index.js'
import type { LaunchSpec } from '../../../src/driver/index.js'
import { buildSandboxProfile } from '../../../src/driver/sandbox.js'

const resources = { cpus: 2.5, memoryMb: 1024, memoryPerPlayerMb: 0, scratchMb: 64, pids: 128 }

function spec(cpus = resources.cpus): LaunchSpec {
  return {
    image: { ref: 'game-sandbox/session-base:deps-v1' },
    argv: ['{}'],
    sandbox: buildSandboxProfile({ ...resources, cpus }, []),
    sessionId: 'session-1',
  }
}

const release = (): void => undefined

describe('containerCreateOptions', () => {
  it('sizes the numerical thread pools to the whole CPUs of the quota', () => {
    expect(containerCreateOptions(spec(), 'none').Env).toEqual([
      'OMP_NUM_THREADS=2',
      'MKL_NUM_THREADS=2',
      'OPENBLAS_NUM_THREADS=2',
    ])
    expect(containerCreateOptions(spec(0.5), 'none').Env).toContain('OMP_NUM_THREADS=1')
  })

  it('passes no device without a leased GPU', () => {
    const host = containerCreateOptions(spec(), 'none').HostConfig
    expect(host?.DeviceRequests).toBeUndefined()
    expect(host?.Devices).toBeUndefined()
  })

  it('requests the one leased NVIDIA device through the container toolkit, keeping the hardening', () => {
    const host = containerCreateOptions(spec(), 'none', { device: 'GPU-1234', release }).HostConfig
    expect(host?.DeviceRequests).toEqual([
      { Driver: 'nvidia', DeviceIDs: ['GPU-1234'], Capabilities: [['gpu']] },
    ])
    expect(host?.Devices).toBeUndefined()
    expect(host?.CapDrop).toEqual(['ALL'])
    expect(host?.SecurityOpt).toEqual(['no-new-privileges:true'])
    expect(host?.ReadonlyRootfs).toBe(true)
  })
})

describe('variantImageTagPrefix', () => {
  it('keeps the configured prefix for the CPU build and names the CUDA build apart', () => {
    const gpu = { vendor: 'nvidia' as const, devices: ['0'], slotsPerDevice: 1 }
    expect(variantImageTagPrefix({ imageTagPrefix: 'gs' })).toBe('gs')
    expect(variantImageTagPrefix({ imageTagPrefix: 'gs', gpu })).toBe('gs-cuda')
  })
})
