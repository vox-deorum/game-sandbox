/**
 * The GPU passthrough check for a deployment host. It runs only where `SANDBOX_GPU_VENDOR` names a
 * vendor (with its other `SANDBOX_GPU_*` settings in the process environment or `.env`), so CI and
 * GPU-less machines skip it. On a GPU host it builds the CUDA variant of the base image
 * and proves that a sandboxed container sees exactly one leased device and can compute on it.
 */

import { describe, expect, it } from 'vitest'

import { currentSessionBaseImageSpec } from '../../src/build/deps-version.js'
import { loadDockerOptions } from '../../src/config/config.js'
import { createDockerDriver } from '../../src/driver/docker/index.js'
import { buildSandboxProfile } from '../../src/driver/sandbox.js'

const options = loadDockerOptions()

describe.skipIf(options.gpu === undefined)('GPU sandbox', () => {
  it(
    'runs a torch matmul on the one leased GPU',
    async () => {
      const driver = await createDockerDriver(options)
      const image = await driver.ensureImage(currentSessionBaseImageSpec())
      const script =
        'import sys, torch\n' +
        'assert torch.cuda.is_available(), "no GPU visible"\n' +
        'assert torch.cuda.device_count() == 1, torch.cuda.device_count()\n' +
        'x = torch.ones(256, 256, device="cuda")\n' +
        'assert float((x @ x).sum()) == 256.0 ** 3\n' +
        'print("gpu ok", torch.cuda.get_device_name(0), torch.version.cuda)\n'
      const proc = await driver.launch({
        image,
        entrypoint: ['python', '-c', script],
        argv: [],
        sandbox: buildSandboxProfile(
          { cpus: 2, memoryMb: 4096, memoryPerPlayerMb: 0, scratchMb: 256, pids: 512, gpu: true },
          [],
          'none',
          'fail',
        ),
        sessionId: 'it-gpu-sandbox',
      })
      const lines: string[] = []
      const output = (async () => {
        for await (const line of proc.output) lines.push(line)
      })()
      const diagnostics: string[] = []
      const stderr = (async () => {
        for await (const line of proc.diagnostics) diagnostics.push(line)
      })()
      const exit = await proc.exited
      await Promise.all([output, stderr])
      await proc.kill(0)
      expect(exit.code, diagnostics.join('\n')).toBe(0)
      expect(lines.join('\n')).toMatch(/gpu ok/)
    },
    30 * 60_000,
  )
})
