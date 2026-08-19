import { describe, expect, it } from 'vitest'

import type { ImageSpec, LaunchSpec } from '../src/driver/index.js'
import { FakeDriver, type FakeSessionProcess } from './support/fake-driver.js'

const IMAGE_SPEC: ImageSpec = { kind: 'session-base', depsVersion: 1 }

function launchSpec(overrides: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    image: { ref: 'fake-image:session-base:deps-v1' },
    argv: ['--config', '{}'],
    sandbox: {
      cpus: 1,
      memoryMb: 512,
      readOnlyRoot: true,
      scratch: { containerPath: '/scratch', sizeMb: 256 },
      network: 'none',
      mounts: [{ hostPath: '/data/recordings', containerPath: '/recordings', readOnly: false }],
      pids: 512,
    },
    sessionId: 'sess-1',
    ...overrides,
  }
}

/** Drain an async iterable into an array (the iterable must end). */
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const value of iterable) {
    out.push(value)
  }
  return out
}

describe('FakeDriver', () => {
  it('records ensureImage and returns a deterministic ref', async () => {
    const driver = new FakeDriver()
    const ref = await driver.ensureImage(IMAGE_SPEC)
    expect(ref).toEqual({ ref: 'fake-image:session-base:deps-v1' })
    expect(driver.imageRequests).toEqual([IMAGE_SPEC])
  })

  it('records launches and fires onLaunch before returning', async () => {
    const driver = new FakeDriver()
    const seen: string[] = []
    driver.onLaunch = (launch) => seen.push(launch.spec.sessionId)

    const process = await driver.launch(launchSpec())
    expect(seen).toEqual(['sess-1']) // fired synchronously, already visible
    expect(driver.launches).toHaveLength(1)
    expect(driver.lastLaunch()?.process).toBe(process)
    expect(driver.lastLaunch()?.spec.sessionId).toBe('sess-1')
  })

  it('delivers emitted output lines in order, then completes when finished', async () => {
    const driver = new FakeDriver()
    const process = (await driver.launch(launchSpec())) as FakeSessionProcess

    // Emit before anyone consumes (buffered), then finish to close the stream.
    process.emit('line-a')
    process.emit('line-b')
    process.finish({ code: 0, oomKilled: false })

    expect(await collect(process.output)).toEqual(['line-a', 'line-b'])
  })

  it('delivers output to a consumer already waiting on the channel', async () => {
    const driver = new FakeDriver()
    const process = (await driver.launch(launchSpec())) as FakeSessionProcess

    const collected = collect(process.output) // starts consuming, nothing buffered yet
    process.emit('x')
    process.emit('y')
    process.finish({ code: 0, oomKilled: false })

    expect(await collected).toEqual(['x', 'y'])
  })

  it('routes diagnostics on a separate channel from output', async () => {
    const driver = new FakeDriver()
    const process = (await driver.launch(launchSpec())) as FakeSessionProcess

    process.emit('state')
    process.emitDiagnostic('warning: slow step')
    process.finish({ code: 0, oomKilled: false })

    expect(await collect(process.output)).toEqual(['state'])
    expect(await collect(process.diagnostics)).toEqual(['warning: slow step'])
  })

  it('records sent lines', async () => {
    const driver = new FakeDriver()
    const process = (await driver.launch(launchSpec())) as FakeSessionProcess

    process.send('{"kind":"input"}')
    process.send('{"kind":"stop"}')
    expect(process.sent).toEqual(['{"kind":"input"}', '{"kind":"stop"}'])
  })

  it('resolves exited with the finishing info and is idempotent', async () => {
    const driver = new FakeDriver()
    const process = (await driver.launch(launchSpec())) as FakeSessionProcess

    process.finish({ code: 3, oomKilled: false })
    process.finish({ code: 99, oomKilled: true }) // ignored: first finish wins
    expect(process.isFinished).toBe(true)
    expect(await process.exited).toEqual({ code: 3, oomKilled: false })
  })

  it('treats oom() as a memory kill', async () => {
    const driver = new FakeDriver()
    const process = (await driver.launch(launchSpec())) as FakeSessionProcess

    process.oom()
    expect(await process.exited).toEqual({ code: 137, oomKilled: true })
  })

  it('records kill grace and finishes the process if not already done', async () => {
    const driver = new FakeDriver()
    const process = (await driver.launch(launchSpec())) as FakeSessionProcess

    await process.kill(5000)
    expect(process.killGraceMs).toEqual([5000])
    expect(await collect(process.output)).toEqual([]) // channel closed by the kill
    expect(await process.exited).toEqual({ code: 137, oomKilled: false })
  })

  it('kill after finish records the call but keeps the original exit', async () => {
    const driver = new FakeDriver()
    const process = (await driver.launch(launchSpec())) as FakeSessionProcess

    process.finish({ code: 0, oomKilled: false })
    await process.kill(1000)
    expect(process.killGraceMs).toEqual([1000])
    expect(await process.exited).toEqual({ code: 0, oomKilled: false })
  })
})
