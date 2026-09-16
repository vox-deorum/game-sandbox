/**
 * Docker overlay helpers that can be proven without a daemon. The real build/list paths ride the
 * Docker-gated suite; this file keeps error handling honest with a tiny fake dockerode surface.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type Docker from 'dockerode'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DockerDriver } from '../../../src/driver/docker/index.js'
import {
  ensureSessionOverlayImage,
  listOverlayImages,
  parseSessionOverlayTag,
  releaseSessionOverlayImage,
  removeImage,
  sessionOverlayImageTag,
} from '../../../src/driver/docker/overlay.js'
import type { SessionOverlaySeat } from '../../../src/driver/index.js'

const DRIVER_OPTIONS = {
  imageTagPrefix: 'gs-test',
  imagePolicy: 'reuse' as const,
  overlayBuildTimeoutMs: 60_000,
  llmRelay: { mode: 'host-gateway' as const },
}

function dockerRemoveRejects(error: unknown): Docker {
  return {
    getImage: () => ({
      remove: () => Promise.reject(error),
    }),
  } as unknown as Docker
}

/** A record of what a {@link fakeBuildDocker} was asked to build and remove, in order. */
interface FakeBuildLog {
  built: string[]
  removed: string[]
  existing: Set<string>
}

/**
 * A dockerode stand-in that drives {@link ensureSessionOverlayImage} without a daemon: each build is
 * recorded and its tag marked present, an `inspect` reports presence, and `remove` untags. `failOn`
 * makes the round whose tag matches reject exactly the way a real failed build step does (an `error`
 * entry in the progress stream), so we can prove the failure/cleanup contract.
 */
function fakeBuildDocker(
  failOn?: (tag: string) => boolean,
  waitOn?: (tag: string) => Promise<void> | undefined,
  waitOnRemove?: (ref: string) => Promise<void> | undefined,
): { docker: Docker; log: FakeBuildLog } {
  const log: FakeBuildLog = { built: [], removed: [], existing: new Set() }
  const docker = {
    buildImage: (context: unknown, options: { t: string }) => {
      // The real dockerode consumes the build context; drain it here (with an error sink) so the
      // `tar.pack` walk of the source tree finishes cleanly instead of leaving a pending readdir that
      // fires after the temp tree is cleaned up.
      const stream = context as NodeJS.ReadableStream
      stream.on('error', () => undefined)
      stream.resume()
      return Promise.resolve({ tag: options.t })
    },
    modem: {
      followProgress: (
        stream: { tag: string },
        onFinished: (err: Error | null, output: Array<{ error?: string }>) => void,
      ) => {
        const complete = (): void => {
          if (failOn?.(stream.tag)) {
            onFinished(null, [{ error: `build of ${stream.tag} failed` }])
            return
          }
          log.built.push(stream.tag)
          log.existing.add(stream.tag)
          onFinished(null, [])
        }
        const wait = waitOn?.(stream.tag)
        if (wait === undefined) {
          complete()
        } else {
          void wait.then(complete, (error: Error) => onFinished(error, []))
        }
      },
    },
    getImage: (ref: string) => ({
      inspect: () =>
        log.existing.has(ref) ? Promise.resolve({}) : Promise.reject({ statusCode: 404 }),
      remove: async () => {
        log.removed.push(ref)
        await waitOnRemove?.(ref)
        log.existing.delete(ref)
      },
    }),
  } as unknown as Docker
  return { docker, log }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('overlay removeImage', () => {
  it('tolerates an image that is already absent', async () => {
    await expect(
      removeImage(dockerRemoveRejects({ statusCode: 404 }), 'overlay:gone'),
    ).resolves.toBeUndefined()
  })

  it('propagates daemon failures so the eviction sweep can log them', async () => {
    const error = Object.assign(new Error('daemon is unhappy'), { statusCode: 500 })

    await expect(removeImage(dockerRemoveRejects(error), 'overlay:stuck')).rejects.toThrow(
      'daemon is unhappy',
    )
  })
})

describe('parseSessionOverlayTag', () => {
  const PREFIX = 'gs-test'

  it('parses a final completed composition into its key, not staged', () => {
    const tag = sessionOverlayImageTag(PREFIX, 3, [
      { seatId: 'seat_0', submissionId: 'sub-a', sourceTreePath: '/tmp/x' },
    ])
    const parsed = parseSessionOverlayTag(PREFIX, tag)
    expect(parsed).not.toBeNull()
    expect(parsed?.staged).toBe(false)
    expect(parsed?.key).toMatch(/^3-[0-9a-f]{32}$/)
  })

  it('parses a -stage scratch intermediate of the same composition as staged', () => {
    const tag = sessionOverlayImageTag(PREFIX, 3, [
      { seatId: 'seat_0', submissionId: 'sub-a', sourceTreePath: '/tmp/x' },
    ])
    const parsed = parseSessionOverlayTag(PREFIX, `${tag}-stage1`)
    expect(parsed).not.toBeNull()
    expect(parsed?.staged).toBe(true)
  })

  it('rejects tags from the per-submission repo and unrelated ones', () => {
    expect(
      parseSessionOverlayTag(PREFIX, `${PREFIX}/submission-overlay:deps-v3-some-id`),
    ).toBeNull()
    expect(parseSessionOverlayTag(PREFIX, `${PREFIX}/session-overlay:not-ours`)).toBeNull()
    expect(parseSessionOverlayTag(PREFIX, 'busybox:latest')).toBeNull()
    // A stage suffix on a non-session repo is not ours either.
    expect(
      parseSessionOverlayTag(PREFIX, `${PREFIX}/submission-overlay:deps-v3-x-stage0`),
    ).toBeNull()
  })
})

describe('listOverlayImages', () => {
  const PREFIX = 'gs-test'

  it('enumerates both overlay repositories with their kind and stage flag', async () => {
    const sessionTag = sessionOverlayImageTag(PREFIX, 1, [
      { seatId: 'seat_0', submissionId: 'sub-a', sourceTreePath: '/tmp/x' },
    ])
    const docker = {
      listImages: () =>
        Promise.resolve([
          { Created: 100, RepoTags: [`${PREFIX}/submission-overlay:deps-v1-sub-a`] },
          { Created: 200, RepoTags: [sessionTag] },
          { Created: 300, RepoTags: [`${sessionTag}-stage0`] },
          { Created: 400, RepoTags: ['node:22-bookworm-slim', 'busybox:latest'] },
        ]),
    } as unknown as Docker

    const images = await listOverlayImages(docker, PREFIX)

    expect(images).toEqual([
      {
        ref: `${PREFIX}/submission-overlay:deps-v1-sub-a`,
        kind: 'submission',
        submissionId: 'sub-a',
        createdAtMs: 100_000,
      },
      {
        ref: sessionTag,
        kind: 'session',
        submissionId: null,
        staged: false,
        createdAtMs: 200_000,
      },
      {
        ref: `${sessionTag}-stage0`,
        kind: 'session',
        submissionId: null,
        staged: true,
        createdAtMs: 300_000,
      },
    ])
  })
})

describe('releaseSessionOverlayImage', () => {
  const PREFIX = 'gs-test'

  it('removes a composed session-overlay tag', async () => {
    const docker = {
      getImage: (ref: string) => ({
        remove: () => {
          expect(ref).toContain('/session-overlay:')
          return Promise.resolve()
        },
      }),
    } as unknown as Docker

    await expect(
      releaseSessionOverlayImage(
        docker,
        PREFIX,
        `${PREFIX}/session-overlay:deps-v1-abcdef0123456789abcdef0123456789`,
      ),
    ).resolves.toBeUndefined()
  })

  it('is a no-op for a per-submission overlay (a shared cache entry) and a base image', async () => {
    let removed = 0
    const docker = {
      getImage: () => ({
        remove: () => {
          removed += 1
          return Promise.resolve()
        },
      }),
    } as unknown as Docker

    await releaseSessionOverlayImage(docker, PREFIX, `${PREFIX}/submission-overlay:deps-v1-sub-a`)
    await releaseSessionOverlayImage(docker, PREFIX, 'node:22-bookworm-slim')
    expect(removed).toBe(0)
  })

  it('tolerates an already-absent session tag', async () => {
    const docker = {
      getImage: () => ({
        remove: () => Promise.reject({ statusCode: 404 }),
      }),
    } as unknown as Docker

    await expect(
      releaseSessionOverlayImage(
        docker,
        PREFIX,
        `${PREFIX}/session-overlay:deps-v1-abcdef0123456789abcdef0123456789`,
      ),
    ).resolves.toBeUndefined()
  })
})

describe('ensureSessionOverlayImage chaining', () => {
  const PREFIX = 'gs-test'
  const DEPS = 3
  // One real (empty) source tree, shared by every composed seat: `buildContext` walks it with
  // `tar.pack`, so it must exist for the whole file (the fake docker never consumes the stream, and
  // the composition tag keys off seat id + submission id, not the tree path).
  let tree = ''

  beforeAll(() => {
    tree = mkdtempSync(join(tmpdir(), 'gs-session-overlay-'))
  })
  afterAll(() => {
    rmSync(tree, { recursive: true, force: true })
  })

  /** A composed spec over `n` seats, all staged from the shared source tree. */
  function spec(n: number): { seats: SessionOverlaySeat[] } {
    const seats: SessionOverlaySeat[] = []
    for (let i = 0; i < n; i++) {
      seats.push({ seatId: `seat_${i}`, submissionId: `sub-${i}`, sourceTreePath: tree })
    }
    return { seats }
  }

  it('applies the final reuse-cache tag only on the last round, staging the rest under scratch tags', async () => {
    const { docker, log } = fakeBuildDocker()
    const composed = spec(3)
    const finalTag = sessionOverlayImageTag(PREFIX, DEPS, composed.seats)

    const ref = await ensureSessionOverlayImage(docker, PREFIX, 'reuse', 60_000, 'base:tag', {
      kind: 'session-overlay',
      depsVersion: DEPS,
      seats: composed.seats,
    })

    expect(ref.ref).toBe(finalTag)
    // The final tag is built once, and only as the last of the three rounds — never mid-chain.
    expect(log.built).toEqual([`${finalTag}-stage0`, `${finalTag}-stage1`, finalTag])
    // The scratch tags are cleaned up; only the complete final image is left tagged.
    expect(log.removed).toEqual([`${finalTag}-stage0`, `${finalTag}-stage1`])
    expect([...log.existing]).toEqual([finalTag])
  })

  it('builds a single-seat composition straight to the final tag with no scratch tags', async () => {
    const { docker, log } = fakeBuildDocker()
    const composed = spec(1)
    const finalTag = sessionOverlayImageTag(PREFIX, DEPS, composed.seats)

    await ensureSessionOverlayImage(docker, PREFIX, 'reuse', 60_000, 'base:tag', {
      kind: 'session-overlay',
      depsVersion: DEPS,
      seats: composed.seats,
    })

    expect(log.built).toEqual([finalTag])
    expect(log.removed).toEqual([])
  })

  it('leaves the final tag unwritten and cleans up scratch tags when a later round fails', async () => {
    const composed = spec(3)
    const finalTag = sessionOverlayImageTag(PREFIX, DEPS, composed.seats)
    // Fail the second round (the first scratch stage succeeds, so there is an intermediate to clean up).
    const { docker, log } = fakeBuildDocker((tag) => tag === `${finalTag}-stage1`)

    await expect(
      ensureSessionOverlayImage(docker, PREFIX, 'reuse', 60_000, 'base:tag', {
        kind: 'session-overlay',
        depsVersion: DEPS,
        seats: composed.seats,
      }),
    ).rejects.toThrow(/failed/)

    // The final (reuse-cache) tag was never written, so a later identical seating rebuilds instead of
    // launching a half-composed image; the completed scratch stage is not left leaked.
    expect(log.existing.has(finalTag)).toBe(false)
    expect(log.removed).toEqual([`${finalTag}-stage0`])
    expect(log.existing.has(`${finalTag}-stage0`)).toBe(false)
  })

  it('returns the cached image untouched under reuse when the final tag already exists', async () => {
    const { docker, log } = fakeBuildDocker()
    const composed = spec(2)
    const finalTag = sessionOverlayImageTag(PREFIX, DEPS, composed.seats)
    log.existing.add(finalTag)

    const ref = await ensureSessionOverlayImage(docker, PREFIX, 'reuse', 60_000, 'base:tag', {
      kind: 'session-overlay',
      depsVersion: DEPS,
      seats: composed.seats,
    })

    expect(ref.ref).toBe(finalTag)
    expect(log.built).toEqual([])
  })
})

describe('DockerDriver composed image ownership', () => {
  const DEPS = 1
  let tree = ''

  beforeAll(() => {
    tree = mkdtempSync(join(tmpdir(), 'gs-shared-session-overlay-'))
  })
  afterAll(() => {
    rmSync(tree, { recursive: true, force: true })
  })

  function imageSpec(seatCount = 1) {
    return {
      kind: 'session-overlay' as const,
      depsVersion: DEPS,
      seats: Array.from({ length: seatCount }, (_, index) => ({
        seatId: `seat_${index}`,
        submissionId: `sub-${index}`,
        sourceTreePath: tree,
      })),
    }
  }

  it('shares one concurrent build and deletes the image only after the last release', async () => {
    const { docker, log } = fakeBuildDocker()
    const driver = new DockerDriver(docker, DRIVER_OPTIONS)
    const spec = imageSpec()

    const [first, second] = await Promise.all([driver.ensureImage(spec), driver.ensureImage(spec)])

    expect(first).toEqual(second)
    expect(log.built).toEqual([first.ref])

    await driver.releaseSessionOverlay(first.ref)
    expect(log.removed).toEqual([])

    await driver.releaseSessionOverlay(second.ref)
    expect(log.removed).toEqual([first.ref])
  })

  it('drops failed acquisition state so the same composition can retry', async () => {
    let failFirst = true
    const { docker, log } = fakeBuildDocker(() => {
      if (!failFirst) {
        return false
      }
      failFirst = false
      return true
    })
    const driver = new DockerDriver(docker, DRIVER_OPTIONS)
    const spec = imageSpec()

    const failed = await Promise.allSettled([driver.ensureImage(spec), driver.ensureImage(spec)])
    expect(failed).toEqual([
      expect.objectContaining({ status: 'rejected' }),
      expect.objectContaining({ status: 'rejected' }),
    ])
    const retried = await driver.ensureImage(spec)

    expect(log.built).toEqual([retried.ref])
    await driver.releaseSessionOverlay(retried.ref)
    expect(log.removed).toEqual([retried.ref])
  })

  it('waits for last-release deletion before a new acquisition rebuilds the image', async () => {
    const spec = imageSpec()
    const tag = sessionOverlayImageTag(DRIVER_OPTIONS.imageTagPrefix, DEPS, spec.seats)
    const removalStarted = deferred()
    const allowRemoval = deferred()
    const { docker, log } = fakeBuildDocker(undefined, undefined, (ref) => {
      if (ref !== tag) {
        return undefined
      }
      removalStarted.resolve()
      return allowRemoval.promise
    })
    const driver = new DockerDriver(docker, DRIVER_OPTIONS)
    const first = await driver.ensureImage(spec)

    const releasing = driver.releaseSessionOverlay(first.ref)
    await removalStarted.promise
    const reacquiring = driver.ensureImage(spec)

    allowRemoval.resolve()
    await releasing
    const second = await reacquiring

    expect(second).toEqual(first)
    expect(log.built).toEqual([tag, tag])
    expect(log.removed).toEqual([tag])

    await driver.releaseSessionOverlay(second.ref)
    expect(log.removed).toEqual([tag, tag])
  })

  it('protects scratch eviction during an unfinished build and permits reclamation later', async () => {
    const spec = imageSpec(2)
    const tag = sessionOverlayImageTag(DRIVER_OPTIONS.imageTagPrefix, DEPS, spec.seats)
    const scratch = `${tag}-stage0`
    const finalBuildStarted = deferred()
    const allowFinalBuild = deferred()
    const { docker, log } = fakeBuildDocker(undefined, (roundTag) => {
      if (roundTag !== tag) {
        return undefined
      }
      finalBuildStarted.resolve()
      return allowFinalBuild.promise
    })
    const driver = new DockerDriver(docker, DRIVER_OPTIONS)
    const acquiring = driver.ensureImage(spec)

    await finalBuildStarted.promise
    expect(log.built).toEqual([scratch])
    await driver.removeImage(scratch)
    expect(log.removed).toEqual([])

    allowFinalBuild.resolve()
    const image = await acquiring
    expect(log.removed).toEqual([scratch])

    log.existing.add(scratch)
    await driver.removeImage(scratch)
    expect(log.removed).toEqual([scratch, scratch])

    await driver.releaseSessionOverlay(image.ref)
    expect(log.removed).toEqual([scratch, scratch, tag])
  })
})
