/**
 * The live-session socket wrapper the session page composes (see
 * plans/stage-04.5/page-restructure.md). It owns the SessionSocket lifecycle and the session chrome
 * state derived from its frames — connection, status, paused, end reason, final result — and exposes
 * the pause/stop/input actions. The renderer frames (header and state) are handed back to the caller
 * through `frames`, because mounting the renderer is the page's concern, not the socket's.
 *
 * Pause state is never tracked locally: it reflects the pause/resume echoes the backend broadcasts, so
 * the UI cannot disagree with the container.
 */
import type { RecordingHeader, StepState } from '@game-sandbox/schema'
import type { Command } from '@game-sandbox/schema/protocol'
import { onBeforeUnmount, ref, shallowRef } from 'vue'

import { type ConnectionState, SessionSocket } from '../api/socket.js'
import { formatScoreMap } from '../replay/summary.js'

/** The recording frames the page wires to its renderer. */
export interface SessionFrameHandlers {
  onHeader(header: RecordingHeader): void
  onState(state: StepState): void
}

export function useSessionSocket(sessionId: string, frames: SessionFrameHandlers) {
  const connection = ref<ConnectionState>('connecting')
  const status = ref<'starting' | 'running' | 'ended'>('starting')
  const paused = ref(false)
  const endReason = ref<string | null>(null)
  const finalResult = ref<{ score: string | null; ticks: number | null } | null>(null)
  // shallowRef: the socket is an imperative class, not reactive data.
  const socket = shallowRef<SessionSocket | null>(null)

  /** Open the socket. The caller gates this on identity and metadata being resolved, and skips it
   *  entirely for an already-ended session (a historical view with no live transport). */
  function connect(): void {
    const client = new SessionSocket(`/api/sessions/${sessionId}/ws`, {
      onHeader: frames.onHeader,
      onState: frames.onState,
      onSessionStatus: (next, reason) => {
        status.value = next
        if (next === 'ended') {
          endReason.value = reason ?? endReason.value
        }
      },
      onPause: () => {
        paused.value = true
      },
      onResume: () => {
        paused.value = false
      },
      onResult: (value) => {
        const scores = (value.scores ?? {}) as Record<string, number>
        finalResult.value = {
          score: formatScoreMap(scores),
          ticks: typeof value.ticks === 'number' ? value.ticks : null,
        }
        if (typeof value.reason === 'string') {
          endReason.value = value.reason
        }
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
    socket.value?.close()
    socket.value = null
  }

  onBeforeUnmount(close)

  return {
    connection,
    status,
    paused,
    endReason,
    finalResult,
    connect,
    send,
    togglePause,
    stop,
    close,
  }
}
