/**
 * The renderer mount/teardown the session and replay pages share (see
 * plans/stage-04.5/page-restructure.md). It resolves the environment's module from the registry,
 * mounts it into the host element with the controlled players and optional live `sendAction`, relays
 * states to it, and tears it down on unmount. It also surfaces the module's aspect ratio so the page
 * can size the stage element and place the decision log beside (portrait) or below (landscape) it.
 *
 * Mount is idempotent: the live socket replays the header on every reconnect, but the renderer mounts
 * once and is fed states thereafter.
 */
import type { RecordingHeader, StepState } from '@game-sandbox/schema'
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import {
  type MaybeRefOrGetter,
  onBeforeUnmount,
  type Ref,
  ref,
  shallowRef,
  toValue,
  watch,
} from 'vue'

import { getRenderer } from '../renderers/registry.js'
import type { RendererInstance, RenderOptions } from '../renderers/types.js'

export interface UseRendererMountOptions {
  host: Ref<HTMLElement | null>
  meta: Ref<EnvironmentMeta | null>
  /** The stable player ids this user controls; empty when spectating or replaying. */
  controlledPlayers?: MaybeRefOrGetter<readonly string[]>
  /** Live human input forwarder; absent for spectators and replays (draw-only). */
  sendAction?: (playerId: string, action: unknown) => void
  /** Receives the renderer's report of who can act right now; absent outside live human play. */
  onControlHeld?: (playerId: string | null) => void
  /** Whether the host's playout is paused, so a renderer can freeze its move clock with it. */
  paused?: MaybeRefOrGetter<boolean>
}

export function useRendererMount(options: UseRendererMountOptions) {
  // shallowRef: the instance is an imperatively mutated class, not reactive data.
  const instance = shallowRef<RendererInstance | null>(null)
  const noRenderer = ref(false)
  // The renderer's declared shape (width / height): the page sizes the stage with a CSS aspect-ratio
  // and seats the decision log beside a portrait canvas (< 1) or below a landscape one. The base class
  // owns the pixel sizing and scaling within that shape; the host only needs the ratio.
  const aspectRatio = ref<number | null>(null)

  function mount(header: RecordingHeader): void {
    if (instance.value !== null || options.meta.value === null || options.host.value === null) {
      return
    }
    const renderer = getRenderer(options.meta.value.renderer)
    if (renderer === undefined) {
      noRenderer.value = true
      return
    }
    const players = toValue(options.controlledPlayers ?? [])
    const mounted = renderer.mount({
      container: options.host.value,
      meta: options.meta.value,
      header,
      controlledPlayers: players,
      // Input only for the owner of controlled players; a spectator or replay gets a draw-only renderer.
      sendAction: players.length > 0 ? options.sendAction : undefined,
      // Same gate: only a session someone plays has a move clock to hold.
      setControlHeld: players.length > 0 ? options.onControlHeld : undefined,
    })
    // The shape is carried by the instance now; surface it for the page's stage layout.
    aspectRatio.value = mounted.aspectRatio
    instance.value = mounted
    if (options.paused !== undefined) {
      mounted.setPaused?.(toValue(options.paused))
    }
  }

  /** Draw a state, resolving once the renderer's transition for it has finished. A page with no
   *  renderer resolves at once, so a paced host waiting on the frame is never left hanging. */
  function render(state: StepState, options?: RenderOptions): Promise<void> {
    return instance.value?.render(state, options) ?? Promise.resolve()
  }

  function destroy(): void {
    instance.value?.destroy()
    instance.value = null
  }

  const pausedOption = options.paused
  if (pausedOption !== undefined) {
    watch(
      () => toValue(pausedOption),
      (value) => instance.value?.setPaused?.(value),
    )
  }

  onBeforeUnmount(destroy)

  return { instance, noRenderer, aspectRatio, mount, render, destroy }
}
