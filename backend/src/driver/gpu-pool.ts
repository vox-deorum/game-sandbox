/**
 * A fixed pool of GPU slots for sandboxes that lease a device.
 *
 * Each device offers `slotsPerDevice` concurrent leases (1 means exclusive), and a lease takes the
 * least-loaded device so shared GPUs fill evenly. The pool is driver-neutral: it hands out device
 * names from configuration, and the driver maps a leased name onto its own platform.
 */
import type { GpuBusyPolicy } from './index.js'

/** Raised by a `fail` lease when every slot is taken, so a live session can tell the user at once. */
export class GpuBusyError extends Error {
  constructor() {
    super('all GPUs are busy; try again when a running session ends')
    this.name = 'GpuBusyError'
  }
}

/** One held slot. Releasing more than once is a no-op, so every teardown path may call it. */
export interface GpuLease {
  readonly device: string
  release(): void
}

export class GpuPool {
  private readonly load: Map<string, number>
  private readonly waiters: Array<() => void> = []

  constructor(
    devices: readonly string[],
    private readonly slotsPerDevice: number,
  ) {
    this.load = new Map(devices.map((device) => [device, 0]))
  }

  /** How many leases the pool can hold at once. */
  get capacity(): number {
    return this.load.size * this.slotsPerDevice
  }

  /** Lease a slot. `wait` queues until one frees; `fail` throws {@link GpuBusyError} instead. */
  async lease(whenBusy: GpuBusyPolicy): Promise<GpuLease> {
    for (;;) {
      const lease = this.tryLease()
      if (lease !== undefined) {
        return lease
      }
      if (whenBusy === 'fail') {
        throw new GpuBusyError()
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
  }

  private tryLease(): GpuLease | undefined {
    let device: string | undefined
    let least = this.slotsPerDevice
    for (const [candidate, held] of this.load) {
      if (held < least) {
        device = candidate
        least = held
      }
    }
    if (device === undefined) {
      return undefined
    }
    const leased = device
    this.load.set(leased, least + 1)
    let released = false
    return {
      device: leased,
      release: () => {
        if (released) {
          return
        }
        released = true
        this.load.set(leased, (this.load.get(leased) ?? 1) - 1)
        this.waiters.shift()?.()
      },
    }
  }
}
