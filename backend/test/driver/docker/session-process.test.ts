import { PassThrough } from 'node:stream'

import type Docker from 'dockerode'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DockerDriver } from '../../../src/driver/docker/index.js'
import { DockerSessionProcess } from '../../../src/driver/docker/session-process.js'
import { GpuBusyError } from '../../../src/driver/gpu-pool.js'
import type { LaunchSpec } from '../../../src/driver/index.js'
import { buildSandboxProfile } from '../../../src/driver/sandbox.js'

function fakeContainer() {
  const stdio = new PassThrough()
  let exit!: (result: { StatusCode: number }) => void
  const waited = new Promise<{ StatusCode: number }>((resolve) => {
    exit = resolve
  })
  const container = {
    id: 'test-container',
    modem: { demuxStream: vi.fn() },
    attach: vi.fn(async () => stdio),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    inspect: vi.fn(async () => ({ State: { ExitCode: 0, OOMKilled: false } })),
    wait: vi.fn(() => waited),
  }
  return { container, exit }
}

const driverOptions = {
  imageTagPrefix: 'gs-test',
  imagePolicy: 'reuse' as const,
  overlayBuildTimeoutMs: 60_000,
  llmRelay: { mode: 'host-gateway' as const },
  gpu: { vendor: 'nvidia' as const, devices: ['0'], slotsPerDevice: 1 },
}

function gpuSpec(whenBusy: 'fail' | 'wait' = 'fail', signal?: AbortSignal): LaunchSpec {
  return {
    image: { ref: 'test-image' },
    argv: [],
    sessionId: 'test-session',
    signal,
    sandbox: {
      ...buildSandboxProfile(
        { cpus: 1, memoryMb: 512, memoryPerPlayerMb: 0, scratchMb: 64, pids: 128 },
        [],
      ),
      gpu: { whenBusy },
    },
  }
}

describe('Docker GPU lease lifecycle', () => {
  afterEach(() => vi.useRealTimers())

  it('rejects a kill that cannot confirm the container stopped and keeps its lease until a retry', async () => {
    const { container } = fakeContainer()
    const docker = { createContainer: vi.fn(async () => container) }
    const driver = new DockerDriver(docker as unknown as Docker, driverOptions)
    const process = await driver.launch(gpuSpec())
    container.stop.mockRejectedValueOnce(new Error('daemon unavailable'))
    container.remove.mockRejectedValueOnce(new Error('daemon unavailable'))

    await expect(process.kill(0)).rejects.toThrow('daemon unavailable')
    await expect(driver.launch(gpuSpec())).rejects.toBeInstanceOf(GpuBusyError)
    expect(docker.createContainer).toHaveBeenCalledTimes(1)

    await process.kill(0)
    const next = await driver.launch(gpuSpec())
    await next.kill(0)
    expect(docker.createContainer).toHaveBeenCalledTimes(2)
  })

  it('cancels queued acquisition without creating a container or releasing the held lease', async () => {
    const { container } = fakeContainer()
    const docker = { createContainer: vi.fn(async () => container) }
    const driver = new DockerDriver(docker as unknown as Docker, driverOptions)
    const process = await driver.launch(gpuSpec())
    const abort = new AbortController()
    const waiting = driver.launch(gpuSpec('wait', abort.signal))

    abort.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    await expect(driver.launch(gpuSpec())).rejects.toBeInstanceOf(GpuBusyError)
    expect(docker.createContainer).toHaveBeenCalledTimes(1)
    await process.kill(0)
  })

  it('releases a newly granted lease if cancellation wins before container creation', async () => {
    const { container } = fakeContainer()
    const docker = { createContainer: vi.fn(async () => container) }
    const driver = new DockerDriver(docker as unknown as Docker, driverOptions)
    const abort = new AbortController()
    const pending = driver.launch(gpuSpec('wait', abort.signal))
    abort.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(docker.createContainer).not.toHaveBeenCalled()
    const process = await driver.launch(gpuSpec())
    await process.kill(0)
  })

  it.each([
    'attach',
    'start',
  ] as const)('retries removal after failed %s without releasing the GPU while teardown is unconfirmed', async (operation) => {
    vi.useFakeTimers()
    const { container } = fakeContainer()
    const docker = { createContainer: vi.fn(async () => container) }
    const driver = new DockerDriver(docker as unknown as Docker, driverOptions)
    container[operation].mockRejectedValueOnce(new Error('launch failed'))
    container.remove.mockRejectedValueOnce(new Error('removal failed'))

    await expect(driver.launch(gpuSpec())).rejects.toThrow('launch failed')
    await expect(driver.launch(gpuSpec())).rejects.toBeInstanceOf(GpuBusyError)
    await vi.runOnlyPendingTimersAsync()
    const process = await driver.launch(gpuSpec())
    await process.kill(0)
  })

  it('recovers an abandoned cleanup after repeated daemon failures without retrying the caller', async () => {
    vi.useFakeTimers()
    const { container } = fakeContainer()
    const docker = { createContainer: vi.fn(async () => container) }
    const driver = new DockerDriver(docker as unknown as Docker, driverOptions)
    const process = await driver.launch(gpuSpec())
    container.stop.mockRejectedValueOnce(new Error('daemon unavailable'))
    container.remove.mockRejectedValueOnce(new Error('daemon unavailable'))
    container.remove.mockRejectedValueOnce(new Error('daemon still unavailable'))

    await expect(process.kill(0)).rejects.toThrow('daemon unavailable')
    await vi.runOnlyPendingTimersAsync()
    await expect(driver.launch(gpuSpec())).rejects.toBeInstanceOf(GpuBusyError)
    await vi.runOnlyPendingTimersAsync()

    const next = await driver.launch(gpuSpec())
    await next.kill(0)
    expect(container.remove).toHaveBeenCalledTimes(4)
  })
})

describe('DockerSessionProcess removal', () => {
  afterEach(() => vi.useRealTimers())

  it('treats an already removed container as released and shares successful cleanup', async () => {
    const { container } = fakeContainer()
    const cleanup = vi.fn(async () => undefined)
    const release = vi.fn()
    const process = await DockerSessionProcess.start(
      container as unknown as Docker.Container,
      cleanup,
      release,
    )
    container.remove.mockRejectedValueOnce({ statusCode: 404 })

    await Promise.all([process.kill(0), process.kill(0)])
    await process.kill(0)
    expect(container.remove).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('lets the owner of an exited container finish while failed removal keeps the lease', async () => {
    vi.useFakeTimers()
    const { container, exit } = fakeContainer()
    const release = vi.fn()
    const process = await DockerSessionProcess.start(
      container as unknown as Docker.Container,
      undefined,
      release,
    )
    container.stop.mockRejectedValueOnce(new Error('daemon unavailable'))
    container.remove.mockRejectedValueOnce(new Error('daemon unavailable'))
    container.remove.mockRejectedValueOnce(new Error('daemon still unavailable'))

    exit({ StatusCode: 0 })
    await expect(process.exited).resolves.toEqual({ code: 0, oomKilled: false })
    await expect(process.kill(0)).resolves.toBeUndefined()
    expect(release).not.toHaveBeenCalled()

    await vi.runOnlyPendingTimersAsync()
    expect(release).toHaveBeenCalledTimes(1)
    expect(container.remove).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['stops the container', undefined],
    ['finds it already stopped', { statusCode: 304 }],
  ])('resolves a kill that %s even when removal fails', async (_, stopError) => {
    vi.useFakeTimers()
    const { container } = fakeContainer()
    const release = vi.fn()
    const process = await DockerSessionProcess.start(
      container as unknown as Docker.Container,
      undefined,
      release,
    )
    if (stopError !== undefined) container.stop.mockRejectedValueOnce(stopError)
    container.remove.mockRejectedValueOnce(new Error('daemon unavailable'))

    await expect(process.kill(0)).resolves.toBeUndefined()
    expect(release).not.toHaveBeenCalled()

    await vi.runOnlyPendingTimersAsync()
    expect(release).toHaveBeenCalledTimes(1)
  })
})
