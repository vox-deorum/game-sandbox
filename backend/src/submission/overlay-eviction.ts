/**
 * Overlay-image eviction (Stage 5.4): the sweep that bounds how much disk a deployment's cached
 * `submission-overlay` images consume, modeled directly on the Stage 4 recording-retention sweep.
 *
 * Every submission that reaches the build stage leaves a cached overlay image, so without
 * reclamation the daemon's disk grows one image per submission forever. The safety property that
 * makes eviction simple is that an overlay is **never irreplaceable**: step 6's submission-image
 * helper refetches and rebuilds on demand, so evicting any overlay — even an active one — costs at
 * most a rebuild, never data loss. The only thing to avoid is thrashing the images a viewer is about
 * to watch, so the sweep **exempts the overlay images of the currently active `ready` submissions**
 * (the watch picker's live set) and never evicts them; they count toward the budget but are kept like
 * a pinned recording. Everything else is a superseded or failed submission's image the picker can
 * never launch, so reclaiming it is pure win — oldest-first, down to the budget.
 *
 * It enumerates the daemon's **actual** overlay images (through the driver), not storage rows, so a
 * crash between building an image and writing its row leaves only an orphan the sweep reclaims as
 * debris rather than tripping on. It is driver-neutral: it drives the {@link OverlayImageManager}
 * seam and reads one storage method, learning no Docker specifics.
 */
import type { OverlayImageManager } from '../driver/index.js'
import type { Storage } from '../storage/index.js'
import { SweepTimer } from '../sweep-timer.js'

/** The eviction knobs, sliced from {@link import('../config.js').Config}. */
export interface OverlayEvictionConfig {
  /** Max overlay images retained; active-`ready` images count toward it but are never evicted. */
  overlayImageBudget: number
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
    private readonly log: (message: string) => void = () => {},
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
   * the remaining budget, and remove the rest oldest-first. Safe to call concurrently with itself —
   * {@link OverlayImageManager.removeImage} tolerates an already-absent image. Also the hook the
   * worker calls after each successful overlay build, the other moment the image set grows.
   */
  async sweep(): Promise<void> {
    let images: Awaited<ReturnType<OverlayImageManager['listOverlayImages']>>
    try {
      images = await this.driver.listOverlayImages()
    } catch (error) {
      this.log(`overlay-eviction: listing images failed: ${String(error)}`)
      return
    }

    let exemptIds: string[]
    try {
      exemptIds = await this.storage.listActiveReadySubmissionIds()
    } catch (error) {
      this.log(`overlay-eviction: reading active submissions failed: ${String(error)}`)
      return
    }
    const exempt = new Set(exemptIds)

    // Exempt (live watch-target) images are always kept but count toward the budget, exactly as a
    // pinned recording counts toward the Stage 4 quota. The non-exempt images fill whatever budget
    // remains, newest first; the rest are evicted oldest-first. If the exempt set alone meets or
    // exceeds the budget, no non-exempt image is retained — correct, since they are all superseded
    // or failed images the picker can never launch.
    const nonExempt = images
      .filter((image) => !exempt.has(image.submissionId))
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
    const exemptCount = images.length - nonExempt.length
    const remainingCapacity = Math.max(0, this.config.overlayImageBudget - exemptCount)

    for (const image of nonExempt.slice(remainingCapacity)) {
      try {
        await this.driver.removeImage(image.ref)
      } catch (error) {
        this.log(`overlay-eviction: removing ${image.ref} failed: ${String(error)}`)
      }
    }
  }
}
