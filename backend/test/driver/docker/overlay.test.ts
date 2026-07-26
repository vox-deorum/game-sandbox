/**
 * Docker overlay helpers that can be proven without a daemon. The real build/list paths ride the
 * Docker-gated suite; this file keeps error handling honest with a tiny fake dockerode surface.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type Docker from 'dockerode'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  ensureSessionOverlayImage,
  removeImage,
  sessionOverlayImageTag,
} from '../../../src/driver/docker/overlay.js'
import type { SessionOverlaySeat } from '../../../src/driver/index.js'

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
function fakeBuildDocker(failOn?: (tag: string) => boolean): { docker: Docker; log: FakeBuildLog } {
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
        if (failOn?.(stream.tag)) {
          onFinished(null, [{ error: `build of ${stream.tag} failed` }])
          return
        }
        log.built.push(stream.tag)
        log.existing.add(stream.tag)
        onFinished(null, [])
      },
    },
    getImage: (ref: string) => ({
      inspect: () =>
        log.existing.has(ref) ? Promise.resolve({}) : Promise.reject({ statusCode: 404 }),
      remove: () => {
        log.removed.push(ref)
        log.existing.delete(ref)
        return Promise.resolve()
      },
    }),
  } as unknown as Docker
  return { docker, log }
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
