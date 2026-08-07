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
 * the cadence relative to one second as the animation scale, so an animated renderer (Hearts, Crane
 * Reach) runs its transitions at replay-time speed, while a scrub, step, or seek snaps, since jumping
 * to an arbitrary frame must not trigger a transition. A draw-only renderer (Flappy Bird) ignores all
 * of this.
 *
 * Play is a serialized pump rather than an interval. Each frame starts two clocks at once, the cadence
 * and the renderer's own transition, and the next frame waits for both. A draw-only recording therefore
 * still plays exactly on its cadence, while a frame whose animation is genuinely longer (a four-tile
 * Crane Reach charge into a kill) holds the pump until it has finished rather than being cut off. A
 * generation token retires the running pump, so a pause, a seek, or a teardown can never leave an
 * obsolete one advancing behind the live one.
 */
import type { StepState } from '@game-sandbox/schema'

import type { RenderOptions } from '../renderers/types.js'

/** The cadence a scale of 1 corresponds to: a one-second beat is a renderer's natural speed. */
const NATURAL_CADENCE_MS = 1_000

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
   * an animated renderer how to present it: a scale while playing, snap for any direct jump. A
   * returned promise is the renderer's transition, which play waits on alongside the cadence.
   */
  onFrame: (state: StepState, options: RenderOptions) => void | Promise<void>
  /** Notify the host of the transport's state so it can render controls. */
  onChange?: (state: ReplayState) => void
}

export class ReplayTransport {
  private idx = 0
  private isPlaying = false
  /** Bumped whenever playback is retired, so a pump from a superseded run stops at its next step. */
  private generation = 0
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
      void this.render({ snap: true })
    }
    this.isPlaying = true
    this.emit()
    this.startPump()
  }

  pause(): void {
    // Retiring the generation is what stops the pump: it checks the token before every step.
    this.generation += 1
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
    void this.render({ snap: true })
    this.emit()
    // A seek while playing restarts the pump, so the frame landed on gets a whole cadence rather than
    // whatever was left of the one it interrupted.
    if (this.isPlaying) this.startPump()
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
    void this.render({ snap: true })
    this.emit()
  }

  destroy(): void {
    this.pause()
  }

  /** Retire any running pump and start a fresh one for the current position. */
  private startPump(): void {
    this.generation += 1
    void this.pump(this.generation)
  }

  /**
   * Advance one frame at a time, each step waiting for the cadence and the previous frame's transition
   * together. The frame already on screen holds for a cadence before the first advance, exactly as the
   * interval this replaced did.
   */
  private async pump(generation: number): Promise<void> {
    let ready: Promise<unknown> = delay(this.cadence)
    while (true) {
      await ready
      if (this.generation !== generation) return
      if (this.idx >= this.total - 1) break
      this.idx += 1
      // Playing forward: give an animated renderer the cadence as its transition scale, so it animates
      // the step (a Hearts trick sweep) at replay-time speed rather than jumping.
      const drawn = this.render({ transitionScale: this.cadence / NATURAL_CADENCE_MS })
      this.emit()
      // Stop as soon as the last frame is shown, rather than waiting one more cadence to notice.
      if (this.idx >= this.total - 1) break
      ready = Promise.all([delay(this.cadence), drawn])
    }
    this.pause()
  }

  private render(options: RenderOptions): Promise<void> {
    const state = this.states[this.idx]
    return state === undefined
      ? Promise.resolve()
      : Promise.resolve(this.opts.onFrame(state, options))
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

/** The cadence floor for one paced frame. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
