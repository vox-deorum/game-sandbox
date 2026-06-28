/**
 * The replay transport: a plain client-side controller over an in-memory array of states. The
 * renderer's purity rule makes every operation the same call — render state _i_ — so play, pause,
 * step, and scrub are all just moving the index and rendering the state under it.
 *
 * Play advances on the environment's pace interval when set, reproducing the live feel; an unpaced
 * environment plays at a fixed default cadence, since turn timings in the recording reflect agent
 * think time, not viewing pace. The transport owns no DOM and no renderer — it calls `onFrame` with
 * the state to draw and `onChange` with its own state, so the host page stays a thin reactive shell.
 *
 * It also tells the renderer how to present each frame (the {@link RenderOptions}): a play step passes
 * the cadence as the animation budget, so an animated renderer (Hearts) runs its transitions at
 * replay-time scale, while a scrub, step, or seek snaps, since jumping to an arbitrary frame must not
 * trigger a transition. A draw-only renderer (Flappy Bird) ignores all of this.
 */
import type { StepState } from '@game-sandbox/schema'

import type { RenderOptions } from '../renderers/types.js'

/** A fixed viewing cadence for an unpaced environment (turn timings are think time, not pace). */
const DEFAULT_CADENCE_MS = 500

/** The transport's observable state, pushed to the host on every change. */
export interface ReplayState {
  index: number
  total: number
  playing: boolean
  tick: number | null
}

export interface ReplayTransportOptions {
  paceIntervalMs?: number | null
  /**
   * Draw the current state. Called for every index change (play, step, scrub, seek). `options` tells
   * an animated renderer how to present it: a budget while playing, snap for any direct jump.
   */
  onFrame: (state: StepState, options: RenderOptions) => void
  /** Notify the host of the transport's state so it can render controls. */
  onChange?: (state: ReplayState) => void
}

export class ReplayTransport {
  private idx = 0
  private isPlaying = false
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly cadence: number

  constructor(
    private readonly states: readonly StepState[],
    private readonly opts: ReplayTransportOptions,
  ) {
    const pace = opts.paceIntervalMs
    this.cadence = pace && pace > 0 ? pace : DEFAULT_CADENCE_MS
  }

  get total(): number {
    return this.states.length
  }

  get index(): number {
    return this.idx
  }

  get playing(): boolean {
    return this.isPlaying
  }

  /** Start advancing on the cadence. At the last frame, play stops rather than looping. */
  play(): void {
    if (this.isPlaying || this.total === 0) {
      return
    }
    // Restarting from the end replays from the top.
    if (this.idx >= this.total - 1) {
      this.idx = 0
      this.render({ snap: true })
    }
    this.isPlaying = true
    this.timer = setInterval(() => this.advance(), this.cadence)
    this.emit()
  }

  pause(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.isPlaying = false
    this.emit()
  }

  toggle(): void {
    this.isPlaying ? this.pause() : this.play()
  }

  /** Step one state forward (pausing first); a no-op at the end. */
  stepForward(): void {
    this.pause()
    this.seek(this.idx + 1)
  }

  /** Step one state back (pausing first); a no-op at the start. */
  stepBack(): void {
    this.pause()
    this.seek(this.idx - 1)
  }

  /** Jump to an index (clamped) and render the state under it — the scrubber's operation (snaps). */
  seek(index: number): void {
    const clamped = Math.max(0, Math.min(this.total - 1, index))
    this.idx = clamped
    this.render({ snap: true })
    this.emit()
  }

  /** Seek to the frame at a tick (exact, else the latest frame at or before it) — the `?t=` deep link. */
  seekToTick(tick: number): void {
    let target = 0
    for (let i = 0; i < this.states.length; i++) {
      const t = this.states[i]?.tick
      if (t === undefined) {
        continue
      }
      if (t === tick) {
        target = i
        break
      }
      if (t <= tick) {
        target = i
      }
    }
    this.seek(target)
  }

  /** Render the current frame without changing the index (the initial draw after mount); snaps. */
  renderCurrent(): void {
    this.render({ snap: true })
    this.emit()
  }

  destroy(): void {
    this.pause()
  }

  private advance(): void {
    if (this.idx >= this.total - 1) {
      this.pause()
      return
    }
    this.idx += 1
    // Playing forward: give an animated renderer the cadence as its transition budget, so it animates
    // the step (a Hearts trick sweep) at replay-time scale rather than jumping.
    this.render({ transitionMs: this.cadence })
    this.emit()
    // Stop as soon as the last frame is shown, rather than waiting one more cadence to notice.
    if (this.idx >= this.total - 1) {
      this.pause()
    }
  }

  private render(options: RenderOptions): void {
    const state = this.states[this.idx]
    if (state !== undefined) {
      this.opts.onFrame(state, options)
    }
  }

  private emit(): void {
    this.opts.onChange?.({
      index: this.idx,
      total: this.total,
      playing: this.isPlaying,
      tick: this.states[this.idx]?.tick ?? null,
    })
  }
}
