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
 * Composed session overlays are acquired by every session that uses them. Identical concurrent
 * compositions share one image, and each caller releases its acquisition on every exit path. The
 * driver removes the image after the final release. A tag left behind can come from a failed release,
 * a crash, or an interrupted build, so the sweep selects old final tags and scratch intermediates for
 * deletion. The driver rechecks ownership at deletion time, skips active final compositions, and
 * skips scratch tags whose parent build is unfinished. This closes the race between listing an
 * image and a session acquiring it.
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
   * younger than the reclaim-age window. Everything older and every `-stage` intermediate is passed
   * to the driver for deletion. The driver skips any composition that became active after this sweep
   * listed it. Safe to call concurrently with itself because {@link OverlayImageManager.removeImage}
   * tolerates an already-absent image. Also the hook the worker calls after each successful overlay
   * build, the other moment the image set grows.
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
    // A `-stage<i>` build intermediate is selected for reclamation immediately. Final compositions
    // younger than the reclaim age are kept. Older ones are candidates for deletion. In both cases,
    // the driver performs the ownership check at deletion time. It keeps a final tag while any
    // session acquisition is active and keeps a scratch tag only while its parent build is unfinished.
    const staged = images.filter((image) => image.staged === true)
    const aged = images.filter(
      (image) =>
        image.staged !== true && now - image.createdAtMs >= this.config.sessionOverlayReclaimAgeMs,
    )
    return [...staged.map((image) => image.ref), ...aged.map((image) => image.ref)]
  }
}
