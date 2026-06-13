/**
 * The renderer mount/teardown the session and replay pages share (see
 * plans/stage-04.5/page-restructure.md). It resolves the environment's module from the registry,
 * mounts it into the host element with the controlled slots and optional live `sendAction`, relays
 * states to it, and tears it down on unmount. It also surfaces the module's aspect ratio so the page
 * can size the stage element and place the decision log beside (portrait) or below (landscape) it.
 *
 * Mount is idempotent: the live socket replays the header on every reconnect, but the renderer mounts
 * once and is fed states thereafter.
 */
import type { RecordingHeader, StepState } from '@game-sandbox/schema'
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { type MaybeRefOrGetter, onBeforeUnmount, type Ref, ref, shallowRef, toValue } from 'vue'

import { getRenderer } from '../renderers/registry.js'
import type { RendererInstance } from '../renderers/types.js'

export interface UseRendererMountOptions {
  host: Ref<HTMLElement | null>
  meta: Ref<EnvironmentMeta | null>
  /** The slots this user controls; empty when spectating or replaying. */
  controlledSlots?: MaybeRefOrGetter<readonly string[]>
  /** Live human input forwarder; absent for spectators and replays (draw-only). */
  sendAction?: (slot: string, action: unknown) => void
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
    const slots = toValue(options.controlledSlots ?? [])
    const mounted = renderer.mount({
      container: options.host.value,
      meta: options.meta.value,
      header,
      controlledSlots: slots,
      // Input only for the owner of controlled slots; a spectator or replay gets a draw-only renderer.
      sendAction: slots.length > 0 ? options.sendAction : undefined,
    })
    // The shape is carried by the instance now; surface it for the page's stage layout.
    aspectRatio.value = mounted.aspectRatio
    instance.value = mounted
  }

  function render(state: StepState): void {
    instance.value?.render(state)
  }

  function destroy(): void {
    instance.value?.destroy()
    instance.value = null
  }

  onBeforeUnmount(destroy)

  return { instance, noRenderer, aspectRatio, mount, render, destroy }
}
