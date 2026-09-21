/**
 * Why a live session's picture is standing still.
 *
 * A stalled live session looks identical to a dropped connection: the last frame just sits there. The
 * two need different reactions from the player, so the page has to name which one it is. Every state
 * already carries the evidence and nothing read it before this module: each agent reports the time its
 * hooks took (`timing.decision_ms`, plus the optional `chat_ms` and `learn_ms`), and the state as a
 * whole reports the wall clock for the step (`timing.duration_ms`), which also covers the environment
 * transition and overlay extraction. Pair that with when the frame actually reached the browser and the
 * three causes separate: the agents are slow, the server around them is slow, or delivery is slow.
 *
 * Agent time is chargeable time, so an official LLM session discounts verified proxy time from it. That
 * is the right reading here rather than a distortion: agents are expected to make their model calls
 * asynchronously, so a well-behaved agent's hook time is its real compute and reads as exactly that. An
 * agent that instead blocks its hook on a model call is the one thing this split cannot pin on it, since
 * the wait is discounted out of its charge while still sitting in the step. Such a session reports the
 * server rather than the agent, which is why that label names the server and not the environment.
 *
 * Samples are smoothed, because one expensive tick should not flip a badge on and off, and the verdict
 * is deliberately silent unless something is actually wrong. Everything here is pure: the caller feeds
 * it states and a clock reading, so it is directly testable without a socket.
 */
import type { StepState } from '@game-sandbox/schema'

import { formatPlayer } from './format.js'

/** How much weight a new sample carries. Low enough to ride out one slow tick, high enough to react. */
const SMOOTHING = 0.3

/** A tick slower than this is worth naming even where the environment declares no cadence. */
const SLOW_TICK_FLOOR_MS = 1000

/** How far past the expected arrival a frame may drift before delivery is the better explanation. */
const TRANSIT_SLACK_MS = 750

/** The shortest silence worth calling out, for a session whose ticks are quick. */
const NO_SIGNAL_MS = 3000

/** How many times its recent pace a session may go quiet before the silence is the story. */
const NO_SIGNAL_PACE_FACTOR = 2

/** The share of a tick's agent time one player must own before the badge names them instead of the cast. */
const DOMINANT_SHARE = 0.5

/** What the page should say about the session's health, or `null` when there is nothing worth saying. */
export interface HealthVerdict {
  label: string
  tone: 'warning' | 'danger'
}

/** One tick's measurements, smoothed across recent ticks. */
export interface HealthSample {
  /** Summed agent hook time for the tick. */
  agentMs: number
  /** Wall clock for the whole step, including the environment transition. */
  stepMs: number
  /** Delivery delay beyond what the step's own work and the cadence account for. */
  transitMs: number
  /** The player owning most of the tick's agent time, when one does. */
  slowestPlayer: string | null
  /** That player's own hook time. */
  slowestMs: number
}

/** Configuration for timing that a particular live-session transport can measure faithfully. */
export interface SessionHealthOptions {
  /** Players whose completed turns include browser-side deliberation in the recorded step duration. */
  humanPlayers?: ReadonlySet<string>
  /** Whether the session has a transport-authoritative cadence and can diagnose silence or transit. */
  continuous?: boolean
}

/** Total hook time one agent spent on a tick: the decision plus whichever optional hooks ran. */
function agentHookMs(agent: StepState['agents'][string]): number {
  const timing = agent.timing
  if (timing === undefined) {
    return 0
  }
  return (timing.decision_ms ?? 0) + (timing.chat_ms ?? 0) + (timing.learn_ms ?? 0)
}

/** Round to one decimal and drop a trailing `.0`, so a badge reads `2.1s` or `3s` rather than `3.0s`. */
function seconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(1))}s`
}

/**
 * Accumulates per-tick timings and reports what is wrong. One instance per transport connection; the
 * caller builds a fresh one on reconnect so a new socket never inherits the old one's verdict.
 */
export class SessionHealth {
  private sample: HealthSample | null = null
  private lastArrivalMs: number | null = null
  private readonly humanPlayers: ReadonlySet<string>
  private readonly continuous: boolean
  private readonly playerMs = new Map<string, number>()

  constructor({ humanPlayers = new Set<string>(), continuous = true }: SessionHealthOptions = {}) {
    this.humanPlayers = new Set(humanPlayers)
    this.continuous = continuous
  }

  /**
   * Record one state as it arrives off the transport, before any playout pacing, so a watch run's
   * jitter buffer cannot be mistaken for a slow link. `targetMs` is the environment's cadence, or 0
   * for a turn-based environment that paces itself.
   */
  observe(state: StepState, arrivedAtMs: number, targetMs: number): void {
    const stepMs = state.timing.duration_ms
    // A tick cannot arrive sooner than the work it describes plus the cadence it waited for, so
    // anything beyond that is the carrier's doing rather than the session's.
    const expectedMs = Math.max(stepMs, targetMs)
    const transitMs =
      this.lastArrivalMs === null ? 0 : Math.max(0, arrivedAtMs - this.lastArrivalMs - expectedMs)
    this.lastArrivalMs = arrivedAtMs

    // A human's move-clock wait is part of duration_ms in an unpaced session. Clear the preceding
    // server and agent measurements on their completed turn, but retain the arrival anchor above so
    // the next non-human state still gets an honest transit interval.
    if (
      Object.entries(state.agents).some(
        ([player, agent]) => this.humanPlayers.has(player) && agent.action !== undefined,
      )
    ) {
      this.sample = null
      this.playerMs.clear()
      return
    }

    const hookMs = new Map<string, number>()
    for (const [player, agent] of Object.entries(state.agents)) {
      if (!this.humanPlayers.has(player)) {
        hookMs.set(player, agentHookMs(agent))
      }
    }
    const { agentMs, slowestPlayer, slowestMs } = this.blendPlayerMs(hookMs)
    const previous = this.sample
    const dominant = agentMs > 0 && slowestMs / agentMs > DOMINANT_SHARE ? slowestPlayer : null
    this.sample = {
      agentMs,
      stepMs: previous === null ? stepMs : ease(previous.stepMs, stepMs),
      transitMs: previous === null ? transitMs : ease(previous.transitMs, transitMs),
      slowestPlayer: dominant,
      slowestMs,
    }
  }

  /** Smooth every player independently, treating an omitted timing entry as no hook work this tick. */
  private blendPlayerMs(hookMs: ReadonlyMap<string, number>): {
    agentMs: number
    slowestPlayer: string | null
    slowestMs: number
  } {
    const firstSample = this.sample === null
    for (const player of new Set([...this.playerMs.keys(), ...hookMs.keys()])) {
      const previous = this.playerMs.get(player)
      const current = hookMs.get(player) ?? 0
      this.playerMs.set(
        player,
        previous === undefined
          ? firstSample
            ? current
            : ease(0, current)
          : ease(previous, current),
      )
    }

    let agentMs = 0
    let slowestPlayer: string | null = null
    let slowestMs = 0
    for (const [player, playerMs] of this.playerMs) {
      agentMs += playerMs
      if (playerMs > slowestMs) {
        slowestPlayer = player
        slowestMs = playerMs
      }
    }
    return { agentMs, slowestPlayer, slowestMs }
  }

  /**
   * The current verdict, or `null` while the session looks healthy. `nowMs` lets staleness advance
   * between frames; `targetMs` is the same cadence passed to {@link observe}.
   */
  verdict(nowMs: number, targetMs: number): HealthVerdict | null {
    const sample = this.sample
    if (this.continuous && this.lastArrivalMs !== null) {
      // Silence only means something measured against how fast this session actually runs. A village
      // taking four seconds a tick is quiet for four seconds every tick, and calling that a lost
      // signal would flicker over the true answer once per tick.
      const pace = sample === null ? 0 : Math.max(sample.stepMs, targetMs)
      const allowed = Math.max(NO_SIGNAL_MS, pace * NO_SIGNAL_PACE_FACTOR)
      if (nowMs - this.lastArrivalMs > allowed) {
        return { label: 'No signal', tone: 'danger' }
      }
    }
    if (sample === null) {
      return null
    }
    const slowFloor = Math.max(targetMs, SLOW_TICK_FLOOR_MS)
    if (sample.agentMs > slowFloor) {
      return sample.slowestPlayer === null
        ? { label: `Agents ${seconds(sample.agentMs)}`, tone: 'warning' }
        : {
            label: `${formatPlayer(sample.slowestPlayer)} ${seconds(sample.slowestMs)}`,
            tone: 'warning',
          }
    }
    // The step outran the hooks charged inside it. That is the environment transition or overlay work,
    // and it is also where an agent that blocks on a model call lands, since the proxy time it waited
    // on is discounted out of its own charge but still sits in the step. Naming the server rather than
    // the environment keeps the badge true under both readings.
    if (sample.stepMs > slowFloor) {
      return { label: `Server ${seconds(sample.stepMs)}`, tone: 'warning' }
    }
    if (this.continuous && sample.transitMs > TRANSIT_SLACK_MS) {
      return { label: 'Link slow', tone: 'warning' }
    }
    return null
  }
}

/** Fold a new scalar sample into the running one. */
function ease(before: number, after: number): number {
  return before + (after - before) * SMOOTHING
}
