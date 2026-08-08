/**
 * The bounded submission-validation worker (Stage 5.5): the in-process queue that drives a pending
 * submission through the four ordered, logged validation stages — `resolve` (source resolution and
 * pinning plus the read-only checkout), `static` (the manifest checks of step 3), `build` (the
 * overlay image of step 4), and `load` (the sandboxed load check of step 4) — and writes the
 * terminal rollup the watch picker and the form read.
 *
 * It is the one place that orchestrates steps 2–4 end to end; the route only creates the pending row
 * and enqueues its id. Concurrency defaults to one job (local Docker is the bottleneck); the queue is
 * in-process and database-backed, so a restart re-enqueues active `pending` rows and the
 * `(submission_id, stage)` upsert overwrites their earlier checks into a clean fresh run.
 *
 * Two invariants the wrapper guarantees for every job, even on an unexpected throw:
 *   (a) the step-2 {@link TreeHandle} is disposed in a `finally`, the single cleanup point the source
 *       seam delegates, so a build or load check that throws mid-pipeline never leaks the temp tree;
 *   (b) an exception escaping a stage closes the currently-`running` check as `failed` and writes the
 *       matching terminal rollup, so a crashed stage is never left permanently `running` with no
 *       rollup.
 * Each transition writes the per-stage check first and the rollup second, so a poller never sees
 * `ready` (or a `*_failed`) without the corresponding passing/failed check already recorded.
 *
 * The worker is driver-neutral: it drives the {@link ExecutionDriver} seam (overlay build + launch)
 * and the {@link SubmissionSource} seam, learning no Docker or git specifics.
 */
import type { SandboxDefaults } from '../config/config.js'
import type { ExecutionDriver, ImageRef } from '../driver/index.js'
import { buildSandboxProfile } from '../driver/sandbox.js'
import type {
  Storage,
  Submission,
  SubmissionFailureStatus,
  SubmissionStage,
} from '../storage/index.js'
import { decodeSeasonConfig } from '../storage/index.js'
import type { SubmissionSnapshotStore } from './snapshot-store.js'
import type { ResolvedSource, SourceInput, SubmissionSource, TreeHandle } from './source/index.js'
import { SourceError } from './source/index.js'
import { CANONICAL_SUBMISSION_SEAT } from './submission-image.js'
import { measureTreeSize } from './tree-filter.js'
import { runLoadCheck, validateStatic } from './validate/index.js'

/**
 * The seat the build and load stages stage a submission's code into. It must be the canonical seat the
 * warm overlay is later reused for ({@link CANONICAL_SUBMISSION_SEAT}), since the overlay's cache
 * identity is the submission id alone — building or load-checking a different seat would silently
 * disagree with every later reuse of that warm image.
 */
const SEAT_ID = CANONICAL_SUBMISSION_SEAT

/** The minimal enqueue capability the submission route depends on, so a fake satisfies it in tests. */
export interface SubmissionEnqueuer {
  /** Queue a pending submission id for validation. Returns immediately; the pipeline runs in the background. */
  enqueue(submissionId: string): void
}

/** Everything the worker needs, injected so a test assembles it against the FakeDriver and `:memory:`. */
export interface ValidationWorkerDeps {
  /** Builds the overlay image and launches the load check; an {@link ExecutionDriver} satisfies both. */
  driver: ExecutionDriver
  storage: Storage
  source: SubmissionSource
  /** The sandbox quotas the load check runs under — the same profile shape real sessions use. */
  sandbox: SandboxDefaults
  /** Wall-clock ceiling on one load check (`config.submission.loadCheckTimeoutMs`). */
  loadCheckTimeoutMs: number
  /** The durable on-disk snapshot the static stage writes once a submission's tree passes its checks. */
  snapshots: SubmissionSnapshotStore
  /** The site-default cap, in bytes, on a checked-out source tree; a season override takes precedence. */
  submissionMaxSizeBytes: number
  /** The template versions the deployment has a base image for; passed through to the static check. */
  knownTemplateVersions: ReadonlySet<number>
  log?: (message: string) => void
  /** Called after each successful overlay build, the moment the image set grows (the eviction sweep). */
  onOverlayBuilt?: () => void
}

/** Which terminal rollup a stage's failure maps to (resolve/static → static_failed). */
function rollupFor(stage: SubmissionStage): SubmissionFailureStatus {
  switch (stage) {
    case 'resolve':
    case 'static':
      return 'static_failed'
    case 'build':
      return 'build_failed'
    case 'load':
      return 'load_failed'
  }
}

/** The owner-visible text for a thrown value. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A byte count rendered as megabytes to one decimal, for owner-visible messages. */
function asMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1)
}

/** The owner-visible reason a submission is rejected for exceeding its size cap. */
function sizeFailureReason(measuredBytes: number, limitBytes: number): string {
  return (
    `the submission's source is ${asMb(measuredBytes)} MB, over the ${asMb(limitBytes)} MB limit ` +
    `(measured without .git history); reduce the submitted tree and resubmit`
  )
}

/** Reconstruct the source input, preferring the stored commit pin on every Git retry. */
function sourceInput(submission: Submission): SourceInput {
  if (submission.source_kind === 'local') {
    return { kind: 'local', localPath: submission.local_path ?? '' }
  }
  return {
    kind: 'git',
    repoUrl: submission.repo_url ?? '',
    ref: submission.commit_sha ?? submission.ref,
  }
}

export class ValidationWorker implements SubmissionEnqueuer {
  private readonly queue: string[] = []
  private inFlight = 0
  private readonly concurrency = 1
  private idleWaiters: Array<() => void> = []
  private readonly log: (message: string) => void

  constructor(private readonly deps: ValidationWorkerDeps) {
    this.log = deps.log ?? (() => {})
  }

  /** Queue a submission id for validation and kick the pump. */
  enqueue(submissionId: string): void {
    this.queue.push(submissionId)
    this.pump()
  }

  /**
   * Re-enqueue every active `pending` submission on startup, so a restart never strands a submission.
   * The `(submission_id, stage)` upsert overwrites any half-written checks from the interrupted run.
   */
  async start(): Promise<void> {
    const pending = await this.deps.storage.listPendingSubmissions()
    for (const submission of pending) {
      this.enqueue(submission.id)
    }
  }

  /** Resolves once the queue is drained and no job is running — the shutdown and test sync point. */
  whenIdle(): Promise<void> {
    if (this.isIdle()) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve)
    })
  }

  private isIdle(): boolean {
    return this.inFlight === 0 && this.queue.length === 0
  }

  private pump(): void {
    while (this.inFlight < this.concurrency && this.queue.length > 0) {
      const id = this.queue.shift() as string
      this.inFlight += 1
      void this.runJob(id).finally(() => {
        this.inFlight -= 1
        this.pump()
      })
    }
    if (this.isIdle()) {
      const waiters = this.idleWaiters
      this.idleWaiters = []
      for (const resolve of waiters) {
        resolve()
      }
    }
  }

  /**
   * Run one submission through the pipeline. Every exit path disposes the fetched tree; an unexpected
   * throw closes the running stage and writes its rollup. A structured failure from any stage stops
   * the pipeline and writes the matching rollup, leaving later stages unstarted (rendered not-run).
   */
  private async runJob(submissionId: string): Promise<void> {
    const submission = await this.deps.storage.getSubmission(submissionId)
    if (submission === undefined) {
      // The row was hard-deleted out from under us; nothing to validate or roll up.
      return
    }
    const season = await this.deps.storage.getSeason(submission.season_id)
    if (season === undefined) {
      this.log(`validation worker: submission ${submissionId} has no season; skipping`)
      return
    }
    const seasonConfig = decodeSeasonConfig(season.config)
    const depsVersion = seasonConfig.deps_version
    const sizeLimitBytes = this.sizeLimitBytes(seasonConfig.overrides?.submission_max_size_mb)

    let tree: TreeHandle | null = null
    let runningStage: SubmissionStage | null = null
    try {
      // Stage 1 — resolve: pin the source and materialize the read-only checkout.
      runningStage = 'resolve'
      await this.deps.storage.startSubmissionCheck(submissionId, 'resolve')
      let resolved: ResolvedSource
      try {
        resolved = await this.deps.source.resolve(sourceInput(submission))
        tree = await this.deps.source.fetchTree(resolved)
      } catch (error) {
        if (error instanceof SourceError) {
          await this.fail(submissionId, 'resolve', error.message)
          return
        }
        throw error
      }
      if (resolved.commitSha !== null) {
        await this.deps.storage.updateSubmissionPin(submissionId, resolved.commitSha)
      }
      await this.deps.storage.finishSubmissionCheck(submissionId, 'resolve', 'passed')
      runningStage = null

      // Stage 2 — static: the size cap and the manifest checks over the checkout (no participant code
      // runs). The size cap is first: it is a static property of the tree, and over-cap rolls up to
      // `static_failed` like any other static failure. The measured size excludes `.git` and build
      // artifacts (the same filter the snapshot and overlay use), so it bounds the submitted code.
      runningStage = 'static'
      await this.deps.storage.startSubmissionCheck(submissionId, 'static')
      const measured = await measureTreeSize(tree.path, sizeLimitBytes)
      if (measured > sizeLimitBytes) {
        await this.fail(submissionId, 'static', sizeFailureReason(measured, sizeLimitBytes))
        return
      }
      const staticResult = await validateStatic(
        tree.path,
        depsVersion,
        this.deps.knownTemplateVersions,
      )
      if (!staticResult.ok) {
        await this.fail(submissionId, 'static', staticResult.reason.message)
        return
      }
      // The tree passed the size cap and the manifest checks: write the durable snapshot now, before
      // the build reads the same tree and before static passes. A failed write rejects the submission
      // and attempts to remove any stale archive. Admin routes never expose an archive from a
      // `static_failed` row, including when storage also prevents that cleanup.
      try {
        await this.deps.snapshots.write(submissionId, tree.path)
      } catch (error) {
        await this.deps.snapshots
          .delete(submissionId)
          .catch((deleteError) =>
            this.log(
              `validation worker: removing failed snapshot for ${submissionId} failed: ${errorText(deleteError)}`,
            ),
          )
        await this.fail(
          submissionId,
          'static',
          `could not store the durable submission snapshot: ${errorText(error)}`,
        )
        return
      }
      await this.deps.storage.finishSubmissionCheck(submissionId, 'static', 'passed')
      runningStage = null

      // Stage 3 — build: the code-only overlay image on the season's base image.
      runningStage = 'build'
      await this.deps.storage.startSubmissionCheck(submissionId, 'build')
      let image: ImageRef
      try {
        image = await this.deps.driver.ensureImage({
          kind: 'submission-overlay',
          depsVersion,
          submissionId,
          sourceTreePath: tree.path,
          seatId: SEAT_ID,
        })
      } catch (error) {
        await this.fail(submissionId, 'build', errorText(error))
        return
      }
      await this.deps.storage.finishSubmissionCheck(submissionId, 'build', 'passed')
      runningStage = null
      // The image set just grew; reclaim down to the budget (best-effort, never blocks the job).
      this.deps.onOverlayBuilt?.()

      // Stage 4 — load: import-and-construct under the locked-down sandbox; never steps the game.
      runningStage = 'load'
      await this.deps.storage.startSubmissionCheck(submissionId, 'load')
      const loadResult = await runLoadCheck(this.deps.driver, image, {
        sandbox: buildSandboxProfile(this.deps.sandbox, []),
        sessionId: submissionId,
        timeoutMs: this.deps.loadCheckTimeoutMs,
        seatId: SEAT_ID,
      })
      if (!loadResult.ok) {
        await this.fail(submissionId, 'load', `${loadResult.code}: ${loadResult.detail}`)
        return
      }
      await this.deps.storage.finishSubmissionCheck(submissionId, 'load', 'passed')
      runningStage = null

      // All four passed: publish `ready`, the check log already complete.
      await this.rollupReady(submissionId)
    } catch (error) {
      // An unexpected throw inside a stage: close the running check and write its rollup so the job
      // can never be left permanently `running`.
      const detail = errorText(error)
      this.log(
        `validation worker: submission ${submissionId} threw in stage ${runningStage}: ${detail}`,
      )
      if (runningStage !== null) {
        await this.fail(submissionId, runningStage, detail).catch((nested) =>
          this.log(
            `validation worker: recording the crash of ${submissionId} failed: ${String(nested)}`,
          ),
        )
      }
    } finally {
      if (tree !== null) {
        await tree
          .dispose()
          .catch((error) =>
            this.log(
              `validation worker: disposing the tree of ${submissionId} failed: ${String(error)}`,
            ),
          )
      }
    }
  }

  /** Record a stage's failure: the failed check first, then the matching terminal rollup. */
  private async fail(submissionId: string, stage: SubmissionStage, detail: string): Promise<void> {
    await this.deps.storage.finishSubmissionCheck(submissionId, stage, 'failed', detail)
    if (await this.exists(submissionId)) {
      await this.deps.storage.updateSubmissionStatus(submissionId, rollupFor(stage), detail)
    }
  }

  /** Publish a clean run as `ready`, but only if the row still exists. */
  private async rollupReady(submissionId: string): Promise<void> {
    if (await this.exists(submissionId)) {
      await this.deps.storage.updateSubmissionStatus(submissionId, 'ready')
    }
  }

  /** Confirm the row still exists before a terminal update, so stale work never publishes nothing. */
  private async exists(submissionId: string): Promise<boolean> {
    return (await this.deps.storage.getSubmission(submissionId)) !== undefined
  }

  /** The effective byte cap for this submission: the season override when set, else the site default. */
  private sizeLimitBytes(overrideMb: number | undefined): number {
    return overrideMb !== undefined ? overrideMb * 1024 * 1024 : this.deps.submissionMaxSizeBytes
  }
}
