/**
 * Overlay-image eviction (Stage 5.4): the sweep that bounds how much disk a deployment's cached
 * `submission-overlay` and composed `session-overlay` images consume, modeled directly on the Stage 4
 * recording-retention sweep.
 *
 * Every submission that reaches the build stage leaves a cached per-submission overlay image, so
 * without reclamation the daemon's disk grows one image per submission forever. The safety property
 * that makes eviction simple is that an overlay is **never irreplaceable**: step 6's submission-image
 * helper refetches and rebuilds on demand, so evicting any overlay — even an active one — costs at
 * most a rebuild, never data loss. The only thing to avoid is thrashing the images a viewer is about
 * to watch, so the sweep **exempts the overlay images of the currently active `ready` submissions**
 * (the watch picker's live set) and never evicts them; they count toward the budget but are kept like
 * a pinned recording. Everything else is a superseded or failed submission's image the picker can
 * never launch, so reclaiming it is pure win — oldest-first, down to the budget.
 *
 * Composed session overlays are single-use: the orchestrator and workflow runner release one on
 * **every** path — when its session ends naturally, when a cancelled run or failed launch backs out,
 * and even on the pre-launch failure branches — so any tag still present is a never-ended session, a
 * release that failed, crashed, or never ran, or a `-stage` build intermediate the concurrent-build
 * race leaked. Each is rebuildable from stored snapshots, so eviction is always safe. The only ring
 * to avoid breaking is the instant between composing and launching an image, so session overlays
 * newer than {@link OverlayEvictionConfig.sessionOverlayReclaimAgeMs} are kept; **anything older is
 * reclaimed outright** — age alone forces eviction, so even a single under-budget leaked image is
 * eventually swept, never stranded by a small retained set. `-stage` intermediates are always
 * reclaimable debris.
 *
 * It enumerates the daemon's **actual** overlay images (through the driver), not storage rows, so a
 * crash between building an image and writing its row leaves only an orphan the sweep reclaims as
 * debris rather than tripping on. It is driver-neutral: it drives the {@link OverlayImageManager}
 * seam and reads one storage method, learning no Docker specifics.
 */
import type { OverlayImage, OverlayImageManager } from '../driver/index.js'
import { appLog } from '../logging/log-buffer.js'
import type { Storage } from '../storage/index.js'
import { SweepTimer } from '../util/sweep-timer.js'

/** The eviction knobs, sliced from {@link import('../config/config.js').Config}. */
export interface OverlayEvictionConfig {
  /** Max overlay images retained; active-`ready` images count toward it but are never evicted. */
  overlayImageBudget: number
  /** Session overlays younger than this are never evicted (protects a compose about to launch). */
  sessionOverlayReclaimAgeMs: number
  /** How often the sweep runs on its own timer (it also runs at startup and after each build). */
  overlayImageSweepIntervalMs: number
}

/** The single storage read the sweep needs: the exempt set of active-`ready` submission ids. */
type ActiveReadyReader = Pick<Storage, 'listActiveReadySubmissionIds'>

export class OverlayEviction {
  private readonly timer: SweepTimer

  constructor(
    private readonly driver: OverlayImageManager,
    private readonly storage: ActiveReadyReader,
    private readonly config: OverlayEvictionConfig,
  ) {
    this.timer = new SweepTimer(() => void this.sweep(), this.config.overlayImageSweepIntervalMs)
  }

  /** Run the sweep once at startup, then on the configured interval. */
  start(): void {
    this.timer.start()
  }

  /** Stop the interval timer (process shutdown). */
  stop(): void {
    this.timer.stop()
  }

  /**
   * The eviction sweep: keep every active-`ready` image plus the newest non-exempt images that fit
   * the remaining budget, and remove the rest oldest-first. Session overlays are kept only while
   * younger than the reclaim-age window (a compose may still be mid-build); everything older — and
   * every `-stage` intermediate — is reclaimed, so a leaked image is never stranded just because the
   * deployment stays under some retained set. Safe to call concurrently with itself —
   * {@link OverlayImageManager.removeImage} tolerates an already-absent image. Also the hook the
   * worker calls after each successful overlay build, the other moment the image set grows.
   */
  async sweep(): Promise<void> {
    let images: Awaited<ReturnType<OverlayImageManager['listOverlayImages']>>
    try {
      images = await this.driver.listOverlayImages()
    } catch (error) {
      appLog(
        'overlay-eviction',
        `overlay-eviction: listing images failed: ${String(error)}`,
        'error',
      )
      return
    }

    let exemptIds: string[]
    try {
      exemptIds = await this.storage.listActiveReadySubmissionIds()
    } catch (error) {
      appLog(
        'overlay-eviction',
        `overlay-eviction: reading active submissions failed: ${String(error)}`,
        'error',
      )
      return
    }
    const exempt = new Set(exemptIds)

    const removed: string[] = []
    removed.push(
      ...this.trackSubmissionImages(
        images.filter((i) => i.kind === 'submission'),
        exempt,
      ),
    )
    removed.push(...this.trackSessionImages(images.filter((i) => i.kind === 'session')))

    for (const ref of removed) {
      try {
        await this.driver.removeImage(ref)
      } catch (error) {
        appLog(
          'overlay-eviction',
          `overlay-eviction: removing ${ref} failed: ${String(error)}`,
          'error',
        )
      }
    }
  }

  private trackSubmissionImages(images: OverlayImage[], exempt: ReadonlySet<string>): string[] {
    // Exempt (live watch-target) images are always kept but count toward the budget, exactly as a
    // pinned recording counts toward the Stage 4 quota. The non-exempt images fill whatever budget
    // remains, newest first; the rest are evicted oldest-first. If the exempt set alone meets or
    // exceeds the budget, no non-exempt image is retained — correct, since they are all superseded
    // or failed images the picker can never launch.
    const nonExempt = images
      .filter((image) => image.submissionId !== null && !exempt.has(image.submissionId))
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
    const exemptCount = images.length - nonExempt.length
    const remainingCapacity = Math.max(0, this.config.overlayImageBudget - exemptCount)
    return nonExempt.slice(remainingCapacity).map((image) => image.ref)
  }

  private trackSessionImages(images: OverlayImage[]): string[] {
    const now = Date.now()
    // A `-stage<i>` build intermediate is pure overhead after its round ends; always reclaim it.
    // Final compositions younger than the reclaim age are kept: they may be between compose and
    // launch. Anything at or past the reclaim age is, by construction, debris — its session ended a
    // long while ago (releasing the image) or it never launched — so age alone forces its eviction;
    // there is no retained set that could strand a low-count leak.
    const staged = images.filter((image) => image.staged === true)
    const aged = images.filter(
      (image) =>
        image.staged !== true && now - image.createdAtMs >= this.config.sessionOverlayReclaimAgeMs,
    )
    return [...staged.map((image) => image.ref), ...aged.map((image) => image.ref)]
  }
}
