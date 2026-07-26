/**
 * Unit coverage for the sandboxed load-check runner (Stage 5.4), Docker-free: it drives the real
 * {@link runLoadCheck} against the {@link FakeDriver}, hand-emitting the `validate-result` envelope
 * the harness command would print and finishing the fake process. It proves the launch shape (the
 * `validate` entrypoint, the seat repo root, the passed-through sandbox profile), the success and
 * structured-failure mappings, the no-result case, and the timeout-kills path. The real container
 * run rides the Docker-gated suite.
 */
import { describe, expect, it } from 'vitest'

import type { ImageRef, SandboxProfile } from '../../../src/driver/index.js'
import { runLoadCheck } from '../../../src/submission/validate/load-check.js'
import { FakeDriver } from '../../support/fake-driver.js'

const IMAGE: ImageRef = { ref: 'overlay:sub-1' }

const SANDBOX: SandboxProfile = {
  cpus: 1,
  memoryMb: 512,
  readOnlyRoot: true,
  scratch: { containerPath: '/tmp', sizeMb: 64 },
  network: 'none',
  mounts: [],
}

function envelope(payload: Record<string, unknown>): string {
  return JSON.stringify({ kind: 'validate-result', ...payload })
}

describe('runLoadCheck', () => {
  it('launches the validate command against the seat repo root under the given sandbox', async () => {
    const driver = new FakeDriver()
    driver.onLaunch = (launch) => {
      launch.process.emit(envelope({ ok: true, hooks: { learn: false, chat: false } }))
      launch.process.finish({ code: 0, oomKilled: false })
    }

    const result = await runLoadCheck(driver, IMAGE, {
      sandbox: SANDBOX,
      sessionId: 'sub-1',
      timeoutMs: 5_000,
    })

    expect(result).toEqual({ ok: true })
    const spec = driver.lastLaunch()?.spec
    expect(spec?.image).toEqual(IMAGE)
    expect(spec?.entrypoint).toEqual(['python', '-m', 'game_sandbox_harness.validate'])
    expect(spec?.argv).toEqual(['/opt/agents/submissions/seat_0'])
    expect(spec?.sandbox).toBe(SANDBOX)
    expect(spec?.sessionId).toBe('sub-1')
  })

  it('maps a structured failure envelope to its code and detail', async () => {
    const driver = new FakeDriver()
    driver.onLaunch = (launch) => {
      launch.process.emit(
        envelope({ ok: false, code: 'class_not_found', detail: "module has no class 'Missing'" }),
      )
      launch.process.finish({ code: 1, oomKilled: false })
    }

    const result = await runLoadCheck(driver, IMAGE, {
      sandbox: SANDBOX,
      sessionId: 'sub-1',
      timeoutMs: 5_000,
    })

    expect(result).toEqual({
      ok: false,
      code: 'class_not_found',
      detail: "module has no class 'Missing'",
    })
  })

  it('reports no_result when the container exits without emitting an envelope', async () => {
    const driver = new FakeDriver()
    driver.onLaunch = (launch) => {
      launch.process.emitDiagnostic('some stderr noise, never the protocol')
      launch.process.finish({ code: 1, oomKilled: false })
    }

    const result = await runLoadCheck(driver, IMAGE, {
      sandbox: SANDBOX,
      sessionId: 'sub-1',
      timeoutMs: 5_000,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('no_result')
    }
  })

  it('times out and kills a load check that never finishes', async () => {
    const driver = new FakeDriver()
    // Never emit, never finish — let the timeout fire.
    driver.onLaunch = () => {}

    const result = await runLoadCheck(driver, IMAGE, {
      sandbox: SANDBOX,
      sessionId: 'sub-1',
      timeoutMs: 20,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('timeout')
    }
    // The runner hard-kills the hung container.
    expect(driver.lastLaunch()?.process.killGraceMs.length).toBe(1)
  })

  it('times out when launching the load-check container never returns', async () => {
    const launcher = { launch: () => new Promise<never>(() => {}) }

    const result = await runLoadCheck(launcher, IMAGE, {
      sandbox: SANDBOX,
      sessionId: 'sub-1',
      timeoutMs: 20,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('timeout')
    }
  })

  it('honors an explicit seat id in the repo root path', async () => {
    const driver = new FakeDriver()
    driver.onLaunch = (launch) => {
      launch.process.emit(envelope({ ok: true }))
      launch.process.finish({ code: 0, oomKilled: false })
    }

    await runLoadCheck(driver, IMAGE, {
      sandbox: SANDBOX,
      sessionId: 'sub-1',
      timeoutMs: 5_000,
      seatId: 'seat_1',
    })

    expect(driver.lastLaunch()?.spec.argv).toEqual(['/opt/agents/submissions/seat_1'])
  })
})
