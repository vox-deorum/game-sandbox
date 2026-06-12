/**
 * A scripted WebSocket client standing in for the browser. It records every frame with the time it
 * arrived (for the cadence assertions), classifies recording lines (states) from envelopes, and
 * offers a `waitFor` so tests can block until enough states have streamed in.
 */

import { parseStepState, type StepState } from '@game-sandbox/schema'
import WebSocket from 'ws'

export interface TimedFrame {
  raw: string
  at: number
  value: Record<string, unknown>
}

export class WsClient {
  readonly frames: TimedFrame[] = []
  private readonly wakeups: Array<() => void> = []

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data: Buffer) => {
      const raw = data.toString()
      let value: Record<string, unknown> = {}
      try {
        value = JSON.parse(raw)
      } catch {
        // Should never happen on this protocol; keep the raw frame for the test to inspect.
      }
      this.frames.push({ raw, at: Date.now(), value })
      for (const wake of this.wakeups.splice(0)) {
        wake()
      }
    })
  }

  static connect(url: string, user = 'dev-user'): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { 'x-sandbox-user': user } })
      socket.once('open', () => resolve(new WsClient(socket)))
      socket.once('error', reject)
    })
  }

  send(command: object): void {
    this.socket.send(JSON.stringify(command))
  }

  /** The recording-line frames (no top-level `kind`) parsed as states, in arrival order. */
  states(): Array<StepState & { at: number }> {
    const out: Array<StepState & { at: number }> = []
    for (const frame of this.frames) {
      if (typeof frame.value.kind !== 'string' && typeof frame.value.tick === 'number') {
        out.push({ ...parseStepState(frame.value), at: frame.at })
      }
    }
    return out
  }

  /** Frames that are event envelopes, by kind. */
  envelopes(kind: string): Array<Record<string, unknown>> {
    return this.frames.filter((f) => f.value.kind === kind).map((f) => f.value)
  }

  /** Resolve once `predicate` holds over the frames, or reject on timeout. */
  waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
    if (predicate()) {
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitFor timed out')), timeoutMs)
      const check = (): void => {
        if (predicate()) {
          clearTimeout(timer)
          resolve()
        } else {
          this.wakeups.push(check)
        }
      }
      this.wakeups.push(check)
    })
  }

  close(): void {
    this.socket.close()
  }
}
