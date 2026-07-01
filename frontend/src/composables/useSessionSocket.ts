/**
 * The live-session socket wrapper the session page composes (see
 * plans/stage-04.5/page-restructure.md). It owns the SessionSocket lifecycle and the session chrome
 * state derived from its frames — connection, status, paused, end reason, final result — and exposes
 * the pause/stop/input actions. The renderer frames (header and state) are handed back to the caller
 * through `frames`, because mounting the renderer is the page's concern, not the socket's.
 *
 * Pause state is never tracked locally: it reflects the pause/resume echoes the backend broadcasts, so
 * the UI cannot disagree with the container.
 *
 * A watch (scripted) run plays through a client-side jitter buffer. The container runs as fast as it
 * can and the carrier delivers frames unevenly — in bursts, with stalls — so rendering them on arrival
 * makes the animation race ahead and snap to the result. Instead the client buffers frames, waits for
 * a small lead to accumulate (so a late or bursty frame does not starve playback), then plays them out
 * one per cadence tick; an underrun simply holds the last frame until more arrive rather than
 * stuttering. The end facts (the `ended` status and the `result`) ride at the tail of the buffer: they
 * are held until the last buffered frame has been shown, so the animation plays out fully and only then
 * reveals game over.
 *
 * A human session renders its owner's own move the instant it arrives — the owner needs immediate
 * feedback to their input. But when a turn-based env declares a `live_interval_ms`, the *other* seats'
 * moves are throttled: the backend streams the AI replies in a burst (they compute in milliseconds),
 * which would otherwise race the renderer and snap all the cards down at once. A leading-edge throttle
 * renders the first frame after an idle gap (the human's own move, or the opening deal) immediately,
 * then plays the burst that follows out one frame per `live_interval_ms` — each carrying that cadence
 * as the renderer's transition budget so the fly-in/sweep fits the pace. As in the watch buffer, the
 * end facts ride at the tail so game over reveals only once the last move has animated.
 */
import type { RecordingHeader, StepState } from '@game-sandbox/schema'
import type { Command } from '@game-sandbox/schema/protocol'
import { onBeforeUnmount, ref, shallowRef } from 'vue'

import { type ConnectionState, SessionSocket } from '../api/socket.js'
import type { RenderOptions } from '../renderers/types.js'
import { formatScoreMap } from '../replay/summary.js'

/** The viewing cadence for a paced watch run whose environment declares no pace interval. */
const DEFAULT_WATCH_CADENCE_MS = 1000

/** How much playback to buffer before starting, to absorb network jitter. The added startup latency
 *  is irrelevant for a non-interactive watch run, and it keeps a late or bursty frame from starving
 *  the very first cadence ticks. */
const JITTER_BUFFER_LEAD_MS = 150

/** The recording frames the page wires to its renderer. */
export interface SessionFrameHandlers {
  onHeader(header: RecordingHeader): void
  /** Draw one state. `options` tells an animated renderer how to present it (a paced move passes a
   *  transition budget); the leading-edge/unbuffered frames pass none, for the natural duration. */
  onState(state: StepState, options?: RenderOptions): void
}

/** How to drive the live stream. Paced playback is opt-in per session (watch runs only). */
export interface ConnectOptions {
  /** Buffer frames and play them out at {@link paceMs}, holding the end facts until they drain. */
  pace?: boolean
  /** The environment's pace interval; falls back to {@link DEFAULT_WATCH_CADENCE_MS} when unset. */
  paceMs?: number | null
  /**
   * A live human session's cadence (ms) for throttling the *other* seats' moves, so a burst of fast AI
   * replies animates one at a time. The owner's own move still renders on arrival. Absent/`null`/`0`
   * (a realtime env, or any env with no `live_interval_ms`) keeps the unbuffered on-arrival behaviour.
   * Ignored when {@link pace} is set — a session is at most one of the two paced modes.
   */
  liveMs?: number | null
}

export function useSessionSocket(sessionId: string, frames: SessionFrameHandlers) {
  const connection = ref<ConnectionState>('connecting')
  const status = ref<'starting' | 'running' | 'ended'>('starting')
  const paused = ref(false)
  const endReason = ref<string | null>(null)
  const finalResult = ref<{ score: string | null; ticks: number | null } | null>(null)
  // True while playout has begun but the jitter buffer has run dry awaiting more frames, so the page
  // can show a waiting indicator over the held last frame. Only ever set in buffered (watch) mode.
  const buffering = ref(false)
  // shallowRef: the socket is an imperative class, not reactive data.
  const socket = shallowRef<SessionSocket | null>(null)

  // --- watch jitter buffer ---
  // The buffer of frames awaiting their cadence tick, the timer that drains it, whether playout has
  // begun (it waits for the lead to fill), and the end facts held back until the buffer empties so the
  // result lands with the final frame, not ahead of it.
  let pacing = false
  let cadence = DEFAULT_WATCH_CADENCE_MS
  let leadFrames = 1
  let playing = false
  const frameQueue: StepState[] = []
  let paceTimer: ReturnType<typeof setInterval> | null = null
  let endHeld = false
  let heldEndReason: string | null = null
  let heldResult: Record<string, unknown> | null = null
  // The live human throttle cadence (ms); 0 disables it (the on-arrival default). Reuses frameQueue,
  // paceTimer, and the end-hold above — a session is at most one of the two paced modes.
  let liveMs = 0

  function applyResult(value: Record<string, unknown>): void {
    const scores = (value.scores ?? {}) as Record<string, number>
    finalResult.value = {
      score: formatScoreMap(scores),
      ticks: typeof value.ticks === 'number' ? value.ticks : null,
    }
    if (typeof value.reason === 'string') {
      endReason.value = value.reason
    }
  }

  /** Reveal the end of the run: surface the held result, mark ended, and stop draining. */
  function applyEnd(reason: string | null): void {
    if (heldResult !== null) {
      applyResult(heldResult)
      heldResult = null
    }
    status.value = 'ended'
    if (reason !== null) {
      endReason.value = reason
    }
    buffering.value = false
    stopPacer()
  }

  /** Begin playout once the lead buffer has filled, or immediately once the stream has ended so a run
   *  shorter than the lead still plays. After the first start the buffer is allowed to underrun (the
   *  pacer simply holds the last frame), so this only ever flips playout on. */
  function maybeStart(streamEnded: boolean): void {
    if (playing || !(streamEnded || frameQueue.length >= leadFrames)) {
      return
    }
    playing = true
    paceTimer = setInterval(drainOne, cadence)
  }

  function stopPacer(): void {
    if (paceTimer !== null) {
      clearInterval(paceTimer)
      paceTimer = null
    }
  }

  /** Play the next buffered frame; once the buffer drains and the stream has ended, reveal game over.
   *  An empty buffer with the stream still live is an underrun: hold the last frame and flag waiting. */
  function drainOne(): void {
    const state = frameQueue.shift()
    if (state !== undefined) {
      buffering.value = false
      frames.onState(state)
    } else if (!endHeld) {
      buffering.value = true
    }
    if (frameQueue.length === 0 && endHeld) {
      applyEnd(heldEndReason)
    }
  }

  /** The live human throttle. When the window is closed (an idle gap), this frame is the leading edge —
   *  the owner's own move or the opening deal — so it draws immediately at the renderer's natural
   *  duration and opens the window; while the window is open, a follow-up (an AI reply in the burst) is
   *  queued for {@link drainLive} to play out at the cadence. */
  function onLiveState(state: StepState): void {
    if (paceTimer === null) {
      frames.onState(state)
      paceTimer = setInterval(drainLive, liveMs)
    } else {
      frameQueue.push(state)
    }
  }

  /** Play the next throttled frame at the cadence, giving the renderer `liveMs` as its transition budget
   *  so the move animates rather than snaps. An empty queue closes the window (the next idle→frame is a
   *  leading edge again) and, once the stream has ended, reveals game over with the last move shown. */
  function drainLive(): void {
    const state = frameQueue.shift()
    if (state !== undefined) {
      frames.onState(state, { transitionMs: liveMs })
      return
    }
    stopPacer()
    if (endHeld) {
      applyEnd(heldEndReason)
    }
  }

  /** Open the socket. The caller gates this on identity and metadata being resolved, and skips it
   *  entirely for an already-ended session (a historical view with no live transport). Pass
   *  `pace` for a watch run so frames play at the environment's cadence rather than as they arrive. */
  function connect(options: ConnectOptions = {}): void {
    pacing = options.pace === true
    cadence =
      pacing && typeof options.paceMs === 'number' && options.paceMs > 0
        ? options.paceMs
        : DEFAULT_WATCH_CADENCE_MS
    leadFrames = Math.max(1, Math.ceil(JITTER_BUFFER_LEAD_MS / cadence))
    // The live human throttle is the alternative to watch pacing (never both); off unless the env
    // declares a positive cadence.
    liveMs =
      !pacing && typeof options.liveMs === 'number' && options.liveMs > 0 ? options.liveMs : 0
    playing = false
    buffering.value = false
    const client = new SessionSocket(`/api/sessions/${sessionId}/ws`, {
      onHeader: frames.onHeader,
      onState: (state) => {
        if (pacing) {
          frameQueue.push(state)
          maybeStart(false)
        } else if (liveMs > 0) {
          onLiveState(state)
        } else {
          frames.onState(state)
        }
      },
      onSessionStatus: (next, reason) => {
        if (next === 'running') {
          status.value = 'running'
          return
        }
        // ended: hold it while paced frames are still draining, so the result lands with the final
        // frame rather than ahead of it; else reveal it now.
        if (pacing && frameQueue.length > 0) {
          endHeld = true
          heldEndReason = reason ?? null
          maybeStart(true)
          return
        }
        // Live throttle: hold while the window is open — a burst is still queued, or the leading-edge
        // frame (e.g. the human's own trick-completing card) is still animating — so drainLive reveals
        // game over once the last move has played out rather than over its animation.
        if (liveMs > 0 && paceTimer !== null) {
          endHeld = true
          heldEndReason = reason ?? null
          return
        }
        applyEnd(reason ?? endReason.value)
      },
      onPause: () => {
        paused.value = true
      },
      onResume: () => {
        paused.value = false
      },
      onResult: (value) => {
        // In either paced mode (watch buffer or live throttle) the result is held and revealed with the
        // last frame, so the score does not surface ahead of the final animation; otherwise apply now.
        if (pacing || liveMs > 0) {
          heldResult = value
          return
        }
        applyResult(value)
      },
      onConnectionChange: (state) => {
        connection.value = state
      },
    })
    socket.value = client
    client.connect()
  }

  /** Send a command (used by the renderer's live `sendAction` to forward human input). */
  function send(command: Command): void {
    socket.value?.send(command)
  }

  function togglePause(): void {
    socket.value?.send({ kind: paused.value ? 'resume' : 'pause' })
  }

  function stop(): void {
    // Graceful in-band stop; the container flushes its recording and exits.
    socket.value?.send({ kind: 'stop' })
  }

  function close(): void {
    stopPacer()
    socket.value?.close()
    socket.value = null
  }

  onBeforeUnmount(close)

  return {
    connection,
    status,
    paused,
    buffering,
    endReason,
    finalResult,
    connect,
    send,
    togglePause,
    stop,
    close,
  }
}
