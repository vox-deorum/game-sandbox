/**
 * Driver-level sandbox guarantees, exercised against the real base image with an overridden
 * entrypoint so the production image carries no test hooks. These are the exit criteria that only
 * mean something against a real container: the memory quota kills a hog, `network: 'none'` has no
 * route out, and a fresh driver reaps a labeled orphan.
 */

import { createServer } from 'node:net'
import Docker from 'dockerode'
import { afterEach, describe, expect, it } from 'vitest'

import { createDockerDriver } from '../../src/driver/docker/index.js'
import type { SandboxProfile, SessionProcess } from '../../src/driver/index.js'
import { BASE_IMAGE_REF, TAG_PREFIX } from './support/base-image.js'

const SESSION_LABEL = 'game-sandbox.session'
const LLM_NETWORK_LABEL = 'game-sandbox.llm-network'
const LLM_RELAY_LABEL = 'game-sandbox.llm-relay'

function profile(overrides: Partial<SandboxProfile> = {}): SandboxProfile {
  return {
    cpus: 1,
    memoryMb: 512,
    readOnlyRoot: true,
    scratch: { containerPath: '/tmp', sizeMb: 64 },
    network: 'none',
    mounts: [],
    ...overrides,
  }
}

/** Consume a process's channels so a container is never blocked on an unread pipe. */
function drain(proc: SessionProcess): void {
  void (async () => {
    for await (const _ of proc.output) {
      // discard
    }
  })()
  void (async () => {
    for await (const _ of proc.diagnostics) {
      // discard
    }
  })()
}

describe('driver-level sandbox guarantees', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((fn) => fn().catch(() => undefined)))
  })

  it('kills a container that exceeds its memory quota and reports oomKilled', async () => {
    const driver = await createDockerDriver({
      imageTagPrefix: TAG_PREFIX,
      imagePolicy: 'reuse',
      overlayBuildTimeoutMs: 120_000,
    })
    const script =
      'import mmap, os, signal\n' +
      'chunks=[]\n' +
      'try:\n' +
      '  while True:\n' +
      '    m=mmap.mmap(-1, 8 * 1024 * 1024)\n' +
      '    for i in range(0, len(m), 4096):\n' +
      '      m[i:i+1]=b"x"\n' +
      '    chunks.append(m)\n' +
      'except (MemoryError, OSError):\n' +
      '  os.kill(os.getpid(), signal.SIGKILL)\n'
    const proc = await driver.launch({
      image: BASE_IMAGE_REF,
      // Touch anonymous pages until the cgroup quota kills the process. If Python observes the
      // allocation failure first on a particular runtime, terminate with the same SIGKILL shape.
      entrypoint: ['python', '-c', script],
      argv: [],
      sandbox: profile({ memoryMb: 64 }),
      sessionId: 'it-mem-hog',
    })
    drain(proc)
    const exit = await proc.exited
    expect(exit.oomKilled).toBe(true)
  })

  it('has no network route under network: none', async () => {
    const driver = await createDockerDriver({
      imageTagPrefix: TAG_PREFIX,
      imagePolicy: 'reuse',
      overlayBuildTimeoutMs: 120_000,
    })
    // Exit 0 only if an outbound TCP connect succeeds; exit 7 when the network is unreachable.
    const script =
      'import socket,sys\n' +
      'try:\n' +
      '  s=socket.socket(); s.settimeout(3); s.connect(("1.1.1.1",53)); sys.exit(0)\n' +
      'except OSError:\n' +
      '  sys.exit(7)\n'
    const proc = await driver.launch({
      image: BASE_IMAGE_REF,
      entrypoint: ['python', '-c', script],
      argv: [],
      sandbox: profile(),
      sessionId: 'it-no-net',
    })
    drain(proc)
    const exit = await proc.exited
    expect(exit.code).toBe(7)
    expect(exit.oomKilled).toBe(false)
  })

  it('routes an LLM sandbox only through the fixed relay destination', async () => {
    const allowedServer = createServer((socket) => socket.end())
    const otherHostServer = createServer((socket) => socket.end())
    await Promise.all([
      new Promise<void>((resolve) => allowedServer.listen(0, '0.0.0.0', resolve)),
      new Promise<void>((resolve) => otherHostServer.listen(0, '0.0.0.0', resolve)),
    ])
    cleanups.push(
      () => new Promise<void>((resolve) => allowedServer.close(() => resolve())),
      () => new Promise<void>((resolve) => otherHostServer.close(() => resolve())),
    )
    const allowedAddress = allowedServer.address()
    const otherAddress = otherHostServer.address()
    if (allowedAddress === null || typeof allowedAddress === 'string')
      throw new Error('missing port')
    if (otherAddress === null || typeof otherAddress === 'string') throw new Error('missing port')

    const driver = await createDockerDriver(
      {
        imageTagPrefix: TAG_PREFIX,
        imagePolicy: 'reuse',
        overlayBuildTimeoutMs: 120_000,
      },
      allowedAddress.port,
    )
    const script =
      'import socket,sys\n' +
      'def reaches(host,port):\n' +
      '  try:\n' +
      '    s=socket.create_connection((host,port),2); s.close(); return True\n' +
      '  except OSError:\n' +
      '    return False\n' +
      `allowed=reaches("llm-proxy",${allowedAddress.port})\n` +
      `other=reaches("llm-proxy",${otherAddress.port})\n` +
      `direct=reaches("host.docker.internal",${otherAddress.port})\n` +
      'public=reaches("1.1.1.1",53)\n' +
      'sys.exit(0 if allowed and not other and not direct and not public else 9)\n'
    const proc = await driver.launch({
      image: BASE_IMAGE_REF,
      entrypoint: ['python', '-c', script],
      argv: [],
      sandbox: profile({ network: 'llm' }),
      sessionId: 'it-llm-net',
    })
    cleanups.push(() => proc.kill(0))
    drain(proc)

    await expect(proc.exited).resolves.toMatchObject({ code: 0, oomKilled: false })
  })

  it('reaps a labeled orphan container when a new driver constructs', async () => {
    const docker = new Docker()
    const orphan = await docker.createContainer({
      Image: BASE_IMAGE_REF.ref,
      Entrypoint: ['sleep'],
      Cmd: ['120'],
      Labels: { [SESSION_LABEL]: 'it-orphan' },
      HostConfig: { NetworkMode: 'none' },
    })
    await orphan.start()
    cleanups.push(async () => {
      await orphan.remove({ force: true }).catch(() => undefined)
    })
    const orphanAgentNetwork = await docker.createNetwork({
      Name: `game-sandbox-it-orphan-agent-${Date.now()}`,
      Internal: true,
      Labels: { [LLM_NETWORK_LABEL]: 'agent' },
    })
    const orphanEgressNetwork = await docker.createNetwork({
      Name: `game-sandbox-it-orphan-egress-${Date.now()}`,
      Labels: { [LLM_NETWORK_LABEL]: 'egress' },
    })
    const relay = await docker.createContainer({
      Image: BASE_IMAGE_REF.ref,
      Entrypoint: ['sleep'],
      Cmd: ['120'],
      Labels: { [LLM_RELAY_LABEL]: 'true' },
      HostConfig: { NetworkMode: orphanEgressNetwork.id },
    })
    await orphanAgentNetwork.connect({ Container: relay.id })
    await relay.start()
    cleanups.push(async () => {
      await relay.remove({ force: true }).catch(() => undefined)
      await orphanAgentNetwork.remove().catch(() => undefined)
      await orphanEgressNetwork.remove().catch(() => undefined)
    })

    // Constructing a driver reaps every container carrying the session label.
    await createDockerDriver({
      imageTagPrefix: TAG_PREFIX,
      imagePolicy: 'reuse',
      overlayBuildTimeoutMs: 120_000,
    })

    await expect(orphan.inspect()).rejects.toThrow()
    await expect(relay.inspect()).rejects.toThrow()
    await expect(orphanAgentNetwork.inspect()).rejects.toThrow()
    await expect(orphanEgressNetwork.inspect()).rejects.toThrow()
  })
})
