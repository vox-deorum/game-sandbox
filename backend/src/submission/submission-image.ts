/**
 * The submission-image helper (Stage 5.6): ensure a `ready` submission's overlay image is present and
 * return a launch-ready {@link ImageRef}, so the orchestrator can run a submitted agent in a watch
 * session without learning Docker or git specifics.
 *
 * The build stage (step 4) already produced each `ready` submission's overlay, and the eviction sweep
 * exempts active-`ready` images, so on the common watch path the overlay is still cached and this helper
 * returns it without touching the source seam at all. A rebuild is required only when the driver policy
 * forces it (`rebuild`) or the cached overlay was evicted; then, and only then, the helper refetches the
 * pinned source, rebuilds the code-only overlay through the driver, and disposes the checkout. The
 * `submission-overlay` build is deterministic in the submission's `deps_version` and id, so a rebuilt
 * image is byte-for-byte the one the validation worker built.
 */
import type { ImagePolicy } from '../config.js'
import type { ExecutionDriver, ImageRef } from '../driver/index.js'
import type { Submission } from '../storage/index.js'
import type { SourceInput, SubmissionSource } from './source/index.js'

/** Where the base image expects each slot's repo root; lockstep with the overlay Dockerfile and harness. */
const SUBMISSION_SLOT_BASE = '/opt/agents/submissions'

/** The container path the overlay copies a slot's submitted code into: `/opt/agents/submissions/<slot>`. */
export function submissionSlotPath(slotId: string): string {
  return `${SUBMISSION_SLOT_BASE}/${slotId}`
}

/** Reconstruct the source seam's input from a stored submission row, the same mapping the worker uses. */
function sourceInput(submission: Submission): SourceInput {
  if (submission.source_kind === 'local') {
    if (submission.local_path === null || submission.local_path === '') {
      throw new Error('local submission is missing its source path')
    }
    return { kind: 'local', localPath: submission.local_path }
  }
  if (submission.repo_url === null || submission.repo_url === '') {
    throw new Error('git submission is missing its repository URL')
  }
  if (submission.commit_sha === null || submission.commit_sha === '') {
    throw new Error('git submission is missing its pinned commit')
  }
  return { kind: 'git', repoUrl: submission.repo_url, ref: submission.commit_sha }
}

/** Everything the helper needs, injected so a test assembles it against the FakeDriver and a source stub. */
export interface SubmissionImageDeps {
  driver: ExecutionDriver
  /** The source seam, used only when a rebuild is required (to refetch the pinned tree). */
  source: SubmissionSource
  /** The driver's reuse-vs-rebuild policy, so the helper can skip the refetch when reuse is allowed. */
  imagePolicy: ImagePolicy
}

/**
 * Resolve a `ready` submission to a launch-ready overlay {@link ImageRef}. Under `reuse`, a still-cached
 * overlay (matched by submission id) is returned untouched, no source fetch. Otherwise, under
 * `rebuild` policy or after overlay eviction, the pinned source is refetched and the overlay rebuilt
 * through the driver, with the temp checkout disposed in a `finally`.
 */
export async function ensureSubmissionImage(
  deps: SubmissionImageDeps,
  submission: Submission,
  depsVersion: number,
  slotId: string,
): Promise<ImageRef> {
  if (deps.imagePolicy === 'reuse') {
    const cached = (await deps.driver.listOverlayImages()).find(
      (image) => image.submissionId === submission.id,
    )
    if (cached !== undefined) {
      return { ref: cached.ref }
    }
  }
  // A rebuild is required: refetch the pinned source, build the overlay, and dispose the checkout.
  const resolved = await deps.source.resolve(sourceInput(submission))
  const tree = await deps.source.fetchTree(resolved)
  try {
    return await deps.driver.ensureImage({
      kind: 'submission-overlay',
      depsVersion,
      submissionId: submission.id,
      sourceTreePath: tree.path,
      slotId,
    })
  } finally {
    await tree.dispose()
  }
}
