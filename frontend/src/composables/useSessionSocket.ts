/**
 * The live-session socket wrapper the session page composes (see
 * plans/stage-04.5/page-restructure.md). It owns the SessionSocket lifecycle and the session chrome
 * state derived from its frames: connection, status, paused, end reason, final result, and exposes
 * the pause/stop/input actions. The renderer frames (header and state) are handed back to the caller
 * through `frames`, because mounting the renderer is the page's concern, not the socket's.
 *
 * Pause comes in two kinds. A **session pause** travels to the container as a `pause`/`resume` command,
 * and the `paused` ref then follows the echoes the relay broadcasts, so the UI cannot disagree with the
 * container. A **playback pause** never leaves the browser: the session, its cadence, and its move
 * clocks keep running, and only this viewer's frame playout freezes. The environment's `human_pause`
 * metadata picks between them for a human session; a watch run always pauses playout, because its
 * container has usually finished (and its socket closed with it) long before the buffered frames have
 * played out. Either way the frames queued here hold until resume, so the picture really does stop.
 *
 * A watch (scripted) run plays through a client-side jitter buffer. The container runs as fast as it
 * can and the carrier delivers frames unevenly, in bursts with stalls, so rendering them on arrival
 * makes the animation race ahead and snap to the result. Instead the client buffers frames, waits for
 * a small lead to accumulate (so a late or bursty frame does not starve playback), then plays them out
 * one at a time; an underrun simply holds the last frame until more arrive rather than stuttering. The
 * end facts (the `ended` status and the `result`) ride at the tail of the buffer: they are held until
 * the last buffered frame has finished playing, so the animation plays out fully and only then reveals
 * game over.
 *
 * A human session renders its owner's own move the instant it arrives — the owner needs immediate
 * feedback to their input. But when a turn-based env declares a `live_interval_ms`, the *other* players'
 * moves are throttled: the backend streams the AI replies in a burst (they compute in milliseconds),
 * which would otherwise race the renderer and snap all the cards down at once. A leading-edge throttle
 * renders the first frame after an idle gap (the human's own move, or the opening deal) immediately,
 * then plays the burst that follows out one at a time. As in the watch buffer, the end facts ride at
 * the tail so game over reveals only once the last move has animated.
 *
 * Both paced modes run as one serialized pump rather than an interval. Every frame starts two clocks
 * together, the cadence and the renderer's own transition, and the next frame waits for both. The
 * cadence is therefore a minimum delivery interval: a draw-only frame still lands exactly on it, while
 * a move whose animation is genuinely longer holds the queue until it has finished instead of being
 * cut off by the frame behind it. Nothing is ever dropped or coalesced, so the decision log and the
 * chat transcript keep every queued frame in order. A generation token retires the running pump, so a
 * pause, a reconnect, or a teardown can never leave an obsolete one drawing over the live one.
 */
import type { RecordingHeader, StepState } from '@game-sandbox/schema'
import type { Command } from '@game-sandbox/schema/protocol'
import { onBeforeUnmount, ref, shallowRef } from 'vue'

import { type ConnectionState, SessionSocket } from '../api/socket.js'
import {
  latestPlayerScores,
  type PlayerScoreMap,
  type RunSummary,
  toPlayerScores,
} from '../lib/state.js'
import type { RenderOptions } from '../renderers/types.js'
import { formatScoreMap } from '../replay/summary.js'

/** The viewing cadence for a paced watch run whose environment declares no pace interval. */
const DEFAULT_WATCH_CADENCE_MS = 1000

/** The cadence a scale of 1 corresponds to: a one-second beat is a renderer's natural speed. */
const NATURAL_CADENCE_MS = 1000

/** The cadence floor for one paced frame. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** How much playback to buffer before starting, to absorb network jitter. The added startup latency
 *  is irrelevant for a non-interactive watch run, and it keeps a late or bursty frame from starving
 *  the very first cadence ticks. */
const JITTER_BUFFER_LEAD_MS = 150

/** The recording frames the page wires to its renderer. */
export interface SessionFrameHandlers {
  onHeader(header: RecordingHeader): void
  /** Draw one state. `options` tells an animated renderer how to present it (a paced move passes a
   *  transition scale); the leading-edge/unbuffered frames pass none, for the natural duration. A
   *  returned promise is the renderer's transition, which paced playout waits on. */
  onState(state: StepState, options?: RenderOptions): void | Promise<void>
}

/** How to drive the live stream. Paced playback is opt-in per session (watch runs only). */
export interface ConnectOptions {
  /** Buffer frames and play them out at {@link paceMs}, holding the end facts until they drain. */
  pace?: boolean
  /** The environment's pace interval; falls back to {@link DEFAULT_WATCH_CADENCE_MS} when unset. */
  paceMs?: number | null
  /**
   * Wait for the recording header, then use watch pacing only when every attributed player is an agent.
   * This lets the standalone local page share one socket entry point for human and watch launches.
   */
  paceWhenSpectating?: boolean
  /**
   * A live human session's cadence (ms) for throttling the *other* players' moves, so a burst of fast AI
   * replies animates one at a time. The owner's own move still renders on arrival. Absent/`null`/`0`
   * (a realtime env, or any env with no `live_interval_ms`) keeps the unbuffered on-arrival behaviour.
   * Ignored when {@link pace} is set. A session is at most one of the two paced modes.
   */
  liveMs?: number | null
  /**
   * Whether this environment's human sessions pause the container itself (`human_pause: "session"`)
   * rather than only this viewer's playout. Ignored for a watch run, which always pauses playout.
   */
  sessionPause?: boolean
}

export function useSessionSocket(sessionId: string, frames: SessionFrameHandlers) {
  const connection = ref<ConnectionState>('connecting')
  const status = ref<'starting' | 'running' | 'ended'>('starting')
  const paused = ref(false)
  const endReason = ref<string | null>(null)
  const finalResult = ref<RunSummary | null>(null)
  // The latest recorded score for every player seen on the transport. This remains complete when an
  // individually inactive player is absent from later frames and covers reconnect until result arrives.
  const accumulatedScores = shallowRef<PlayerScoreMap>({})
  // Transport-authoritative state advances on receipt, before optional visual pacing. Interactive
  // policy such as chat must follow the harness immediately even while the renderer animates older
  // queued frames.
  const latestState = shallowRef<StepState | null>(null)
  // True while playout has begun but the jitter buffer has run dry awaiting more frames, so the page
  // can show a waiting indicator over the held last frame. Only ever set in buffered (watch) mode.
  const buffering = ref(false)
  // shallowRef: the socket is an imperative class, not reactive data.
  const socket = shallowRef<SessionSocket | null>(null)
  let connectionId = 0

  // --- paced playout ---
  // The queue of frames awaiting their turn, whether the pump is running, whether playout has begun at
  // all (the watch buffer waits for its lead to fill), and the end facts held back until the queue
  // empties so the result lands with the final frame, not ahead of it.
  let pacing = false
  let cadence = DEFAULT_WATCH_CADENCE_MS
  let leadFrames = 1
  let playing = false
  const frameQueue: StepState[] = []
  /** Bumped whenever playout is retired, so a pump from a superseded run stops at its next step. */
  let playoutId = 0
  let pumping = false
  /** The cadence floor and transition of the frame on screen; the next frame waits for both. */
  let framePending: Promise<unknown> = Promise.resolve()
  let endHeld = false
  let heldEndReason: string | null = null
  let heldResult: Record<string, unknown> | null = null
  // The protocol promises one result at session end. Keep the first result from the active connection
  // if a malformed producer repeats it, matching the relay's retained result and termination reason.
  let resultSeen = false
  // The live human throttle cadence (ms); 0 disables it (the on-arrival default). It shares the queue,
  // the pump, and the end-hold above, since a session is at most one of the two paced modes.
  let liveMs = 0
  // Whether this environment's human sessions pause the container rather than only this playout.
  let sessionPause = false

  function applyResult(value: Record<string, unknown>): void {
    const scores = toPlayerScores(value.scores)
    finalResult.value = {
      score: formatScoreMap(scores),
      ticks: typeof value.ticks === 'number' ? value.ticks : null,
      scores,
    }
    if (typeof value.reason === 'string') {
      endReason.value = value.reason
    }
  }

  /** Reveal the end of the run: surface the held result, mark ended, and stop playing out. */
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
    retirePlayout()
  }

  /** The cadence in effect for the active paced mode. */
  function paceMs(): number {
    return pacing ? cadence : liveMs
  }

  /** Begin playout once the lead buffer has filled, or immediately once the stream has ended so a run
   *  shorter than the lead still plays. After the first start the buffer is allowed to underrun (the
   *  pump simply holds the last frame), so this only ever flips playout on. */
  function maybeStart(streamEnded: boolean): void {
    if (!playing && !(streamEnded || frameQueue.length >= leadFrames)) {
      return
    }
    playing = true
    startPump()
  }

  /** Run the playout pump unless one is already running. */
  function startPump(): void {
    if (pumping) {
      return
    }
    pumping = true
    void pump(playoutId)
  }

  /** Retire the running pump. Its generation check stops it at its next step. */
  function retirePlayout(): void {
    playoutId += 1
    pumping = false
    framePending = Promise.resolve()
  }

  /**
   * Play queued frames one at a time, each waiting for the cadence floor and the previous frame's
   * transition together. Draining the queue ends the pump: a later arrival starts it again, so a watch
   * underrun simply holds the last frame under the waiting indicator. Once the stream has ended the
   * pump waits out the final frame before revealing game over, so the result never lands over its
   * own animation.
   */
  async function pump(generation: number): Promise<void> {
    while (true) {
      await framePending
      if (generation !== playoutId) return
      if (paused.value) break
      const state = frameQueue.shift()
      if (state === undefined) {
        if (!endHeld) {
          // An empty queue with the stream still live is an underrun; the watch buffer says so.
          if (pacing) buffering.value = true
          break
        }
        // The queue is empty and the frame before it has already served both its cadence and its
        // transition, which is exactly what the end was being held for.
        applyEnd(heldEndReason)
        return
      }
      buffering.value = false
      framePending = deliver(state, { transitionScale: paceMs() / NATURAL_CADENCE_MS })
    }
    pumping = false
  }

  /** Draw one frame and return when both its cadence floor and its transition have finished. */
  function deliver(state: StepState, options?: RenderOptions): Promise<unknown> {
    const drawn = Promise.resolve(frames.onState(state, options))
    return Promise.all([delay(paceMs()), drawn])
  }

  /** The live human throttle. When nothing is playing out (an idle gap), this frame is the leading edge —
   *  the owner's own move or the opening deal — so it draws immediately at the renderer's natural
   *  duration; the burst behind it then waits for that transition and the cadence before each move. */
  function onLiveState(state: StepState): void {
    if (!pumping && frameQueue.length === 0 && !paused.value) {
      framePending = deliver(state)
      startPump()
      return
    }
    // Paused, or mid-burst: queue it so nothing overtakes what is already waiting.
    frameQueue.push(state)
    if (!paused.value) startPump()
  }

  /** Lift a pause and let whatever piled up behind it play out. Both paced modes restart their pump,
   *  which resumes at the head of the queue. Unbuffered playout has no cadence, so it replays its
   *  backlog at once and reveals an end that was waiting on the viewer. */
  function resumePlayout(): void {
    paused.value = false
    if (pacing) {
      maybeStart(endHeld)
      return
    }
    if (liveMs > 0) {
      startPump()
      return
    }
    flushUnbuffered()
    if (endHeld) {
      applyEnd(heldEndReason)
    }
  }

  /** Retire the current transport before starting another explicit connection. */
  function retireConnection(): void {
    connectionId += 1
    retirePlayout()
    frameQueue.length = 0
    pacing = false
    cadence = DEFAULT_WATCH_CADENCE_MS
    leadFrames = 1
    playing = false
    endHeld = false
    heldEndReason = null
    heldResult = null
    resultSeen = false
    liveMs = 0
    sessionPause = false
    paused.value = false
    buffering.value = false
    socket.value?.close()
    socket.value = null
  }

  /** Replay everything that queued behind an unbuffered pause, in order and at once. There is no
   *  cadence to play it out at, and the page builds its decision and chat logs from these frames, so
   *  every one has to reach it; only the last is left on screen. */
  function flushUnbuffered(): void {
    for (const state of frameQueue.splice(0)) {
      frames.onState(state)
    }
  }

  /** Open the socket. The caller gates this on identity and metadata being resolved, and skips it
   *  entirely for an already-ended session (a historical view with no live transport). Pass
   *  `pace` for a watch run so frames play at the environment's cadence rather than as they arrive. */
  function connect(options: ConnectOptions = {}): void {
    retireConnection()
    const activeConnectionId = connectionId
    const paceWhenSpectating = options.pace !== true && options.paceWhenSpectating === true
    const requestedLiveMs =
      typeof options.liveMs === 'number' && options.liveMs > 0 ? options.liveMs : 0
    pacing = options.pace === true
    sessionPause = options.sessionPause === true
    cadence =
      pacing && typeof options.paceMs === 'number' && options.paceMs > 0
        ? options.paceMs
        : DEFAULT_WATCH_CADENCE_MS
    leadFrames = Math.max(1, Math.ceil(JITTER_BUFFER_LEAD_MS / cadence))
    // The live human throttle is the alternative to watch pacing (never both); off unless the env
    // declares a positive cadence.
    liveMs = !pacing && !paceWhenSpectating ? requestedLiveMs : 0
    const client = new SessionSocket(`/api/sessions/${sessionId}/ws`, {
      onHeader: (header) => {
        if (connectionId === activeConnectionId) {
          if (paceWhenSpectating) {
            pacing = !Object.values(header.players).some((player) => player.kind === 'human')
            cadence =
              pacing && typeof options.paceMs === 'number' && options.paceMs > 0
                ? options.paceMs
                : DEFAULT_WATCH_CADENCE_MS
            leadFrames = Math.max(1, Math.ceil(JITTER_BUFFER_LEAD_MS / cadence))
            liveMs = pacing ? 0 : requestedLiveMs
          }
          frames.onHeader(header)
        }
      },
      onState: (state) => {
        if (connectionId !== activeConnectionId) {
          return
        }
        latestState.value = state
        accumulatedScores.value = {
          ...accumulatedScores.value,
          ...latestPlayerScores([state]),
        }
        if (pacing) {
          frameQueue.push(state)
          maybeStart(false)
        } else if (liveMs > 0) {
          onLiveState(state)
        } else if (paused.value) {
          frameQueue.push(state)
        } else {
          frames.onState(state)
        }
      },
      onSessionStatus: (next, reason) => {
        if (connectionId !== activeConnectionId) {
          return
        }
        if (next === 'running') {
          status.value = 'running'
          // Attach replays `running` first and a `pause` echo after it only while the container is
          // still paused. A session pause whose resume echo was lost with a dropped socket therefore
          // clears itself here, instead of freezing the picture over a game that kept playing.
          if (paused.value && pausesContainer()) {
            resumePlayout()
          }
          return
        }
        // ended: hold it while paced frames are still playing out, so the result lands with the final
        // frame rather than ahead of it; else reveal it now. A pause holds it in every mode too: the
        // viewer stopped the picture, so game over waits until they start it again.
        if (pacing) {
          endHeld = true
          heldEndReason = reason ?? null
          if (!paused.value) maybeStart(true)
          return
        }
        // Live throttle: hold while something is still playing out — a burst is queued, or the
        // leading-edge frame (the human's own trick-completing card) is still animating — so the pump
        // reveals game over once the last move has landed rather than over its animation.
        if (liveMs > 0 && (pumping || frameQueue.length > 0 || paused.value)) {
          endHeld = true
          heldEndReason = reason ?? null
          return
        }
        // Unbuffered: nothing is draining, so only a pause can defer the reveal.
        if (paused.value) {
          endHeld = true
          heldEndReason = reason ?? null
          return
        }
        applyEnd(reason ?? endReason.value)
      },
      onPause: () => {
        if (connectionId === activeConnectionId) {
          paused.value = true
        }
      },
      onResume: () => {
        if (connectionId === activeConnectionId) {
          resumePlayout()
        }
      },
      onResult: (value) => {
        if (connectionId !== activeConnectionId) {
          return
        }
        if (resultSeen) {
          return
        }
        resultSeen = true
        // In either paced mode (watch buffer or live throttle) the result is held and revealed with the
        // last frame, so the score does not surface ahead of the final animation, and a pause holds it
        // for the same reason; otherwise apply now.
        if (pacing || liveMs > 0 || paused.value) {
          heldResult = value
          return
        }
        applyResult(value)
      },
      onConnectionChange: (state) => {
        if (connectionId === activeConnectionId) {
          connection.value = state
        }
      },
    })
    socket.value = client
    client.connect()
  }

  /** Send a command (used by the renderer's live `sendAction` to forward human input). */
  function send(command: Command): void {
    socket.value?.send(command)
  }

  /** Whether this session's pause reaches the container. A watch run always pauses playout locally, so
   *  does an environment whose `human_pause` asks for it, and so does any session whose stream has
   *  already ended, since no command can reach a container that is already gone. */
  function pausesContainer(): boolean {
    return sessionPause && !pacing && !endHeld
  }

  function togglePause(): void {
    if (socket.value === null) {
      return // No transport yet, so there is nothing to pause and nothing to show as paused.
    }
    if (pausesContainer()) {
      // The echo is the authority here: `paused` flips when the relay confirms, not on the click.
      socket.value?.send({ kind: paused.value ? 'resume' : 'pause' })
      return
    }
    if (paused.value) {
      resumePlayout()
    } else {
      paused.value = true
    }
  }

  function stop(): void {
    if (endHeld) {
      // The stream already ended and its socket closed with it, so no command can land. Let go of the
      // pause and reveal the end that playout was holding instead of sending into the void. Unbuffered
      // playout has no animation to skip, so `resumePlayout` finishes it; a paced backlog is dropped,
      // which is what stopping a playback that has outlived its session means. That leaves the
      // decision log short of the frames never shown, and the recording keeps the complete record.
      resumePlayout()
      if (status.value !== 'ended') {
        frameQueue.length = 0
        applyEnd(heldEndReason)
      }
      return
    }
    // A pause must not outlive the run it was holding, or the ended status would never be revealed.
    if (paused.value) {
      resumePlayout()
    }
    // Graceful in-band stop; the container flushes its recording and exits.
    socket.value?.send({ kind: 'stop' })
  }

  function close(): void {
    retireConnection()
    connection.value = 'closed'
  }

  onBeforeUnmount(close)

  return {
    connection,
    status,
    paused,
    buffering,
    endReason,
    finalResult,
    accumulatedScores,
    latestState,
    connect,
    send,
    togglePause,
    stop,
    close,
  }
}
