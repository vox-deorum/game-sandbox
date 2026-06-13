/**
 * The replay transport wrapper the replay page composes (see plans/stage-04.5/page-restructure.md).
 * It owns the ReplayTransport class (the Stage 4 decision that the transport is a small explicit
 * class stands), mirrors its state into a ref for the template, and adds the keyboard map the
 * accessibility baseline requires: space toggles play, the arrows step, Home and End jump.
 *
 * The transport is created lazily through `init` because its states arrive after the recording is
 * fetched and parsed; until then the controls render disabled against the empty initial state.
 */
import type { StepState } from '@game-sandbox/schema'
import { onBeforeUnmount, ref, shallowRef } from 'vue'

import { type ReplayState, ReplayTransport } from '../replay/transport.js'

export function useReplayTransport() {
  const state = ref<ReplayState>({ index: 0, total: 0, playing: false, tick: null })
  // shallowRef: the transport is an imperative class, not reactive data.
  const transport = shallowRef<ReplayTransport | null>(null)

  /** Build the transport over the parsed states. `onFrame` draws the state at the current index. */
  function init(
    states: readonly StepState[],
    options: { paceIntervalMs?: number | null; onFrame: (state: StepState) => void },
  ): ReplayTransport {
    const created = new ReplayTransport(states, {
      paceIntervalMs: options.paceIntervalMs,
      onFrame: (frame) => options.onFrame(frame),
      onChange: (next) => {
        state.value = next
      },
    })
    transport.value = created
    return created
  }

  /** The transport keyboard map for the stage region (space toggles, arrows step, Home/End jump). */
  function onKeydown(event: KeyboardEvent): void {
    const t = transport.value
    if (t === null) {
      return
    }
    switch (event.key) {
      case ' ':
      case 'Spacebar':
        event.preventDefault()
        t.toggle()
        break
      case 'ArrowRight':
        event.preventDefault()
        t.stepForward()
        break
      case 'ArrowLeft':
        event.preventDefault()
        t.stepBack()
        break
      case 'Home':
        event.preventDefault()
        t.seek(0)
        break
      case 'End':
        event.preventDefault()
        t.seek(t.total - 1)
        break
      default:
        break
    }
  }

  onBeforeUnmount(() => {
    transport.value?.destroy()
  })

  return { state, transport, init, onKeydown }
}
