/**
 * The submission-image helper (Stage 5.6): ensure a `ready` submission's overlay image is present and
 * return a launch-ready {@link ImageRef}, so the orchestrator can run a submitted agent in a watch
 * session without learning Docker or git specifics.
 *
 * The build stage (step 4) already produced each `ready` submission's overlay, and the eviction sweep
 * exempts active-`ready` images, so on the common watch path the overlay is still cached and this helper
 * returns it without touching disk or git at all. A rebuild is required only when the driver policy
 * forces it (`rebuild`) or the cached overlay was evicted; then, and only then, the helper materializes
 * the submission's tree, rebuilds the code-only overlay through the driver, and disposes the checkout.
 *
 * The tree comes from the on-disk snapshot the validation worker wrote, not a fresh git clone, so a
 * rebuild no longer depends on the participant's repo still serving the pinned commit (a force-push or
 * deleted ref used to break re-runs here). Because the snapshot was packed with the same filter and sort
 * the overlay build context uses, a rebuild is byte-for-byte the image the worker built. For a
 * pre-snapshot submission (or one whose snapshot write failed) the helper falls back to re-cloning the
 * pinned source through the source seam.
 */
import type { ImagePolicy } from '../config.js'
import type { ExecutionDriver, ImageRef } from '../driver/index.js'
import type { Submission } from '../storage/index.js'
import { SnapshotMissingError, type SubmissionSnapshotStore } from './snapshot-store.js'
import type { SourceInput, SubmissionSource, TreeHandle } from './source/index.js'

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
  /** The snapshot store; a rebuild materializes the submission's tree from here, no git round trip. */
  snapshots: SubmissionSnapshotStore
  /** The source seam, used only as a fallback when a submission has no snapshot (pre-snapshot rows). */
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
  // A rebuild is required: materialize the submission's tree, build the overlay, dispose the checkout.
  // Prefer the durable snapshot; fall back to re-cloning the pinned source only for a submission that
  // has none (a pre-snapshot row, or one whose snapshot write failed).
  const tree = await materializeTree(deps, submission)
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

/** One submission-filled slot of a composed session image: whose code goes in which slot. */
export interface SessionImageSlot {
  slotId: string
  submission: Submission
}

/**
 * Resolve a multi-agent session's composed image: the base image for {@link depsVersion} with every
 * submitted slot's code staged into its own per-slot directory. Each submission's tree is materialized
 * (durable snapshot first, a pinned clone only for a pre-snapshot row) and disposed in a `finally`,
 * even on failure. The image is session-scoped, not cached by submission id, so it is always
 * (re)composed; the real Docker build lands in Stage 7.5, while this resolves the seam against the
 * driver. A submission may fill more than one slot — each entry stages independently, keeping the
 * slots isolated.
 */
export async function ensureSessionImage(
  deps: SubmissionImageDeps,
  slots: readonly SessionImageSlot[],
  depsVersion: number,
): Promise<ImageRef> {
  const trees: { slotId: string; submissionId: string; tree: TreeHandle }[] = []
  try {
    for (const { slotId, submission } of slots) {
      const tree = await materializeTree(deps, submission)
      trees.push({ slotId, submissionId: submission.id, tree })
    }
    return await deps.driver.ensureImage({
      kind: 'session-overlay',
      depsVersion,
      slots: trees.map(({ slotId, submissionId, tree }) => ({
        slotId,
        submissionId,
        sourceTreePath: tree.path,
      })),
    })
  } finally {
    for (const { tree } of trees) {
      await tree.dispose()
    }
  }
}

/** The submission's source tree for a rebuild: the snapshot when present, else a fresh pinned clone. */
async function materializeTree(
  deps: SubmissionImageDeps,
  submission: Submission,
): Promise<TreeHandle> {
  try {
    return await deps.snapshots.materialize(submission.id)
  } catch (error) {
    // Only a pre-snapshot submission (no snapshot on disk) falls back to re-cloning the pinned source.
    if (!(error instanceof SnapshotMissingError)) {
      throw error
    }
  }
  const resolved = await deps.source.resolve(sourceInput(submission))
  return await deps.source.fetchTree(resolved)
}
