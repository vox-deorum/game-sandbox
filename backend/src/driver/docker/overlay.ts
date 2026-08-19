/**
 * Overlay images for the Docker driver (Stage 5.4): build a submission's code-only overlay on the
 * session base image, enumerate the overlays the driver manages, and remove one.
 *
 * The overlay is the base image for a dependency-set version with the fetched submission tree copied
 * into its per-seat directory under `/opt/agents/submissions`. There is **no per-submission
 * dependency install** — the deps come entirely from the base image — so the build is just a `COPY`
 * and is fast. The tag is derived deterministically from the prefix, deps version, and submission id,
 * so the submission id is recoverable from the tag (the eviction sweep relies on it). Caching honors
 * the same {@link ImagePolicy} the base build does, and the build is bounded by a timeout so a hung
 * or pathological build cannot stall the single-concurrency validation worker.
 *
 * This is the one place (with `image.ts`) that touches `dockerode` and `tar-fs`; everything above the
 * driver expresses the build as a driver-neutral {@link SubmissionOverlayImageSpec}.
 */
import { createHash } from 'node:crypto'

import type Docker from 'dockerode'
import tar from 'tar-fs'
import type { Pack } from 'tar-stream'

import type { ImagePolicy } from '../../config/config.js'
import { SUBMISSION_SEAT_BASE } from '../../submission/submission-image.js'
import { submissionTarIgnore } from '../../submission/tree-filter.js'
import type {
  ImageRef,
  OverlayImage,
  SessionOverlayImageSpec,
  SessionOverlaySeat,
  SubmissionOverlayImageSpec,
} from '../index.js'

/** The Docker repository (the part before `:`) every per-submission overlay tag lives under. */
const OVERLAY_REPO_SUFFIX = 'submission-overlay'
/**
 * The repository every composed multi-agent session image lives under. Deliberately distinct from
 * {@link OVERLAY_REPO_SUFFIX}, since {@link listOverlayImages} enumerates only the per-submission
 * overlay repo: a composed session image is session-scoped and never returned to the eviction sweep,
 * exactly as the driver interface promises.
 */
const SESSION_OVERLAY_REPO_SUFFIX = 'session-overlay'

/** Raised when an overlay build exceeds its configured timeout, so the worker records a timeout reason. */
export class OverlayBuildTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`overlay build exceeded its ${timeoutMs}ms timeout`)
    this.name = 'OverlayBuildTimeoutError'
  }
}

/** The overlay repository name (prefix + suffix) all of a deployment's overlay tags share. */
function overlayRepo(prefix: string): string {
  return `${prefix}/${OVERLAY_REPO_SUFFIX}`
}

/**
 * The deterministic tag for an overlay: `<prefix>/submission-overlay:deps-v<N>-<submissionId>`. The
 * submission id is appended whole after the `deps-v<N>-` marker, so {@link parseOverlayTag} can
 * recover it even though a UUID itself contains hyphens.
 */
export function overlayImageTag(prefix: string, depsVersion: number, submissionId: string): string {
  return `${overlayRepo(prefix)}:deps-v${depsVersion}-${submissionId}`
}

/** Recover the submission id from an overlay tag, or null if the tag is not one of ours. */
export function parseOverlayTag(prefix: string, tag: string): string | null {
  const marker = `${overlayRepo(prefix)}:deps-v`
  if (!tag.startsWith(marker)) {
    return null
  }
  // After the marker the shape is `<digits>-<submissionId>`; take everything past the first hyphen.
  const rest = tag.slice(marker.length)
  const hyphen = rest.indexOf('-')
  if (hyphen <= 0) {
    return null
  }
  const submissionId = rest.slice(hyphen + 1)
  return submissionId.length > 0 ? submissionId : null
}

async function imageExists(docker: Docker, tag: string): Promise<boolean> {
  try {
    await docker.getImage(tag).inspect()
    return true
  } catch {
    return false
  }
}

interface BuildProgress {
  stream?: string
  error?: string
  errorDetail?: { message?: string }
}

/**
 * The build context: the source tree under `tree/` plus a generated Dockerfile at the root. The
 * tree is namespaced under `tree/` (via the header `map`) so `COPY tree …` copies only the
 * submission's files and never the Dockerfile itself. `finalize: false` + `finish` appends the
 * Dockerfile entry after `tar-fs` has walked the tree, then finalizes the archive.
 *
 * The `ignore` filter and deterministic `sort` are the determinism keystone: they are the same the
 * snapshot pack uses (`submission/tree-filter.ts`), so an overlay rebuilt from a stored snapshot copies
 * exactly the bytes the original git-checkout build copied. Filtering also drops `.git` and build
 * artifacts that would otherwise be shipped into every overlay for no reason.
 */
function buildContext(sourceTreePath: string, dockerfile: string): NodeJS.ReadableStream {
  return tar.pack(sourceTreePath, {
    ignore: submissionTarIgnore(sourceTreePath),
    sort: true,
    map: (header) => {
      header.name = `tree/${header.name}`
      return header
    },
    finalize: false,
    finish: (pack: Pack) => {
      pack.entry({ name: 'Dockerfile' }, dockerfile, () => pack.finalize())
    },
  })
}

/**
 * The overlay Dockerfile. `COPY tree <dest>` lays the submission's repo root into its seat
 * directory; the `chmod -R a+rX` mirrors the base image's normalization so a tree packed from a host
 * without Unix execute bits (a Windows checkout) still has the directory search bit a CapDrop-ALL
 * container needs to stat the manifest. The base image runs as the non-root `sandbox` user, so the
 * build steps up to root for the normalization (which the non-owner cannot perform) and back down
 * again: sessions, and the next chained overlay round, then run as `sandbox`.
 */
function overlayDockerfile(baseTag: string, seatId: string): string {
  const dest = `${SUBMISSION_SEAT_BASE}/${seatId}`
  return [
    `FROM ${baseTag}`,
    `COPY tree ${dest}`,
    'USER root',
    `RUN chmod -R a+rX ${dest}`,
    'USER sandbox',
    '',
  ].join('\n')
}

/** Run the build stream to completion, rejecting on a build-step error or the configured timeout. */
function runBuild(
  docker: Docker,
  context: NodeJS.ReadableStream,
  tag: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      fn()
    }

    const timer = setTimeout(() => {
      settle(() => {
        // Best-effort teardown: drop the context stream so the daemon stops pulling the build input.
        ;(context as { destroy?: () => void }).destroy?.()
        reject(new OverlayBuildTimeoutError(timeoutMs))
      })
    }, timeoutMs)
    timer.unref?.()

    docker
      .buildImage(context, { t: tag, dockerfile: 'Dockerfile' })
      .then((buildStream) => {
        docker.modem.followProgress(
          buildStream,
          (err: Error | null, output: BuildProgress[]) => {
            if (err) {
              settle(() => reject(err))
              return
            }
            const failure = output.find((entry) => entry.error)
            if (failure) {
              settle(() =>
                reject(
                  new Error(
                    failure.errorDetail?.message ?? failure.error ?? 'overlay build failed',
                  ),
                ),
              )
              return
            }
            settle(resolve)
          },
          () => undefined,
        )
      })
      .catch((error: unknown) => settle(() => reject(error)))
  })
}

/**
 * Resolve a {@link SubmissionOverlayImageSpec} to a launch-ready overlay {@link ImageRef}, building
 * on the base image's tag. Under `reuse` an existing overlay tag is returned untouched; under
 * `rebuild` it is always rebuilt. The base image for the spec's deps version must already exist —
 * the worker ensures it before building overlays — and is referenced by tag in the Dockerfile `FROM`.
 */
export async function ensureOverlayImage(
  docker: Docker,
  prefix: string,
  policy: ImagePolicy,
  timeoutMs: number,
  baseTag: string,
  spec: SubmissionOverlayImageSpec,
): Promise<ImageRef> {
  const tag = overlayImageTag(prefix, spec.depsVersion, spec.submissionId)
  if (policy === 'reuse' && (await imageExists(docker, tag))) {
    return { ref: tag }
  }
  const dockerfile = overlayDockerfile(baseTag, spec.seatId)
  const context = buildContext(spec.sourceTreePath, dockerfile)
  await runBuild(docker, context, tag, timeoutMs)
  return { ref: tag }
}

/** The composed-session-image repository (prefix + suffix) a deployment's session images share. */
function sessionOverlayRepo(prefix: string): string {
  return `${prefix}/${SESSION_OVERLAY_REPO_SUFFIX}`
}

/**
 * The deterministic tag for a composed session image:
 * `<prefix>/session-overlay:deps-v<N>-<hash>`. The hash is a content digest of the seat-to-submission
 * composition over the entries sorted by seat id, so it is independent of the order the seats were
 * supplied. An identical seating therefore resolves to the same tag (so `reuse` policy hits the cache
 * and a re-run of the same match reuses the image), while any change to which submission fills which
 * seat yields a different tag. Hashing keeps the tag a fixed, registry-legal length even though a
 * submission id is a UUID.
 */
export function sessionOverlayImageTag(
  prefix: string,
  depsVersion: number,
  seats: readonly SessionOverlaySeat[],
): string {
  const composition = seats
    .map((seat) => `${seat.seatId}=${seat.submissionId}`)
    .sort()
    .join('\n')
  const hash = createHash('sha256').update(composition).digest('hex').slice(0, 32)
  return `${sessionOverlayRepo(prefix)}:deps-v${depsVersion}-${hash}`
}

/**
 * Resolve a {@link SessionOverlayImageSpec} to a launch-ready composed {@link ImageRef}: the base
 * image for the deps version with every submitted seat's tree copied into its own per-seat directory
 * under `/opt/agents/submissions`, so one container hosts several submitted agents in isolation.
 *
 * The image is built by chaining one single-seat overlay per seat (each a
 * `FROM <previous> ; COPY tree /opt/agents/submissions/<seatId>`), so it reuses the *exact*
 * deterministic single-seat build context (same ignore filter, same `sort`) that the per-submission
 * overlay uses, and each seat's code lands only in its own directory. Seats are staged in sorted
 * seat-id order. The same submission may fill more than one seat; each seat is staged independently
 * from its own source tree, so two seats backed by one repo are as isolated on disk as two different
 * repos.
 *
 * The final (reuse-cache) tag is applied only once, by the last round, and every intermediate round
 * builds under a distinct scratch tag. This keeps the final tag out of the failure/partial window: a
 * failure on any round leaves the final tag unwritten, so a later identical seating under `reuse`
 * rebuilds instead of launching a half-composed image whose later seats would die with a missing-code
 * error, and a concurrent start never observes the final tag mid-chain. The scratch tags are removed
 * in a `finally` (their layers persist inside the final image and are reclaimed by a routine prune,
 * exactly as the old re-tag-in-place chain's dangling intermediates were), so a mid-chain failure
 * leaks no tagged partial image either.
 *
 * Known limitation: two identical seating builds started concurrently will compute the same scratch
 * tags and race on tag cleanup. One build may delete a scratch tag mid-use by another, causing that
 * build to fail with a spurious error. This is rare (requires identical seating started concurrently)
 * and self-healing (a retry succeeds). A future fix could add a per-build unique suffix to scratch tags.
 */
export async function ensureSessionOverlayImage(
  docker: Docker,
  prefix: string,
  policy: ImagePolicy,
  timeoutMs: number,
  baseTag: string,
  spec: SessionOverlayImageSpec,
): Promise<ImageRef> {
  if (spec.seats.length === 0) {
    throw new Error('a session-overlay image needs at least one submitted seat')
  }
  const tag = sessionOverlayImageTag(prefix, spec.depsVersion, spec.seats)
  if (policy === 'reuse' && (await imageExists(docker, tag))) {
    return { ref: tag }
  }
  const seats = [...spec.seats].sort((a, b) =>
    a.seatId < b.seatId ? -1 : a.seatId > b.seatId ? 1 : 0,
  )
  const scratchTags: string[] = []
  let fromTag = baseTag
  try {
    for (let i = 0; i < seats.length; i++) {
      const seat = seats[i] as SessionOverlaySeat
      const isLast = i === seats.length - 1
      // Intermediate rounds build under `<tag>-stage<i>`; only the last round writes the final tag,
      // so the final tag names a complete image or nothing at all.
      const roundTag = isLast ? tag : `${tag}-stage${i}`
      const dockerfile = overlayDockerfile(fromTag, seat.seatId)
      const context = buildContext(seat.sourceTreePath, dockerfile)
      await runBuild(docker, context, roundTag, timeoutMs)
      if (!isLast) {
        scratchTags.push(roundTag)
      }
      fromTag = roundTag
    }
  } finally {
    // Drop the intermediate scratch tags. When the chain completed, the final image already references
    // their layers, so this only untags; when it failed mid-chain, it removes the partial images built
    // so far. Best-effort: a cleanup failure must not mask a build failure or fail a successful build.
    for (const scratch of scratchTags) {
      await removeImage(docker, scratch).catch((error) => {
        // Log but don't propagate: a failed cleanup (e.g., 409 conflict with dependent children) must
        // not mask a successful build. A leaked scratch tag may persist in the registry but its layers
        // are reclaimed by a routine docker image prune.
        console.error(`failed to remove scratch tag ${scratch}:`, error)
      })
    }
  }
  return { ref: tag }
}

/**
 * Enumerate the overlay images this driver manages: every image carrying a tag under the overlay
 * repository, paired with the submission id recovered from that tag and the image's creation time.
 * Base images and unrelated images are never returned (they carry no overlay tag).
 */
export async function listOverlayImages(docker: Docker, prefix: string): Promise<OverlayImage[]> {
  const images = await docker.listImages()
  const overlays: OverlayImage[] = []
  for (const image of images) {
    const createdAtMs = (image.Created ?? 0) * 1000
    for (const tag of image.RepoTags ?? []) {
      const submissionId = parseOverlayTag(prefix, tag)
      if (submissionId !== null) {
        overlays.push({ ref: tag, submissionId, createdAtMs })
      }
    }
  }
  return overlays
}

/** Remove one image by ref, tolerating an already-absent image (a racing sweep or manual cleanup). */
export async function removeImage(docker: Docker, ref: string): Promise<void> {
  try {
    await docker.getImage(ref).remove({ force: true })
  } catch (error) {
    if (isImageNotFound(error)) {
      // Already gone, or removed by a concurrent sweep.
      return
    }
    throw error
  }
}

function isImageNotFound(error: unknown): boolean {
  const candidate = error as {
    statusCode?: unknown
    status?: unknown
    reason?: unknown
    json?: { message?: unknown }
    message?: unknown
  }
  if (candidate.statusCode === 404 || candidate.status === 404) {
    return true
  }
  const message = [candidate.message, candidate.reason, candidate.json?.message]
    .filter((part): part is string => typeof part === 'string')
    .join('\n')
  return /no such image|not found/i.test(message)
}
