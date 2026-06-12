/**
 * Driver-level sandbox guarantees, exercised against the real base image with an overridden
 * entrypoint so the production image carries no test hooks. These are the exit criteria that only
 * mean something against a real container: the memory quota kills a hog, `network: 'none'` has no
 * route out, and a fresh driver reaps a labeled orphan.
 */
import Docker from 'dockerode'
import { afterEach, describe, expect, it } from 'vitest'

import { createDockerDriver } from '../../src/driver/docker/index.js'
import type { SandboxProfile, SessionProcess } from '../../src/driver/index.js'
import { BASE_IMAGE_REF, TAG_PREFIX } from './support/base-image.js'

const SESSION_LABEL = 'game-sandbox.session'

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
    const driver = await createDockerDriver({ imageTagPrefix: TAG_PREFIX, imagePolicy: 'reuse' })
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
    const driver = await createDockerDriver({ imageTagPrefix: TAG_PREFIX, imagePolicy: 'reuse' })
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

    // Constructing a driver reaps every container carrying the session label.
    await createDockerDriver({ imageTagPrefix: TAG_PREFIX, imagePolicy: 'reuse' })

    await expect(orphan.inspect()).rejects.toThrow()
  })
})
