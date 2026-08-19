/**
 * The stage's fullscreen toggle (see StageFrame.vue). It unifies two modes behind one API: the native
 * Fullscreen API when the browser supports it, and a CSS fallback (a `position: fixed` stage canvas)
 * when it does not — jsdom the unit-test DOM in particular reports no `fullscreenEnabled`, so suites
 * always exercise the fallback.
 *
 * The native mode hands size and layout to the browser and syncs state from `fullscreenchange`, so
 * browser-initiated exits (Escape, system UI) stay correct. The fallback can only flip the ref; it
 * adds its own Escape-to-exit and a body scroll lock so the fixed stage does not scroll under itself.
 */
import { type ComputedRef, computed, onBeforeUnmount, type Ref, ref, watch } from 'vue'

export function useFullscreen(target: Ref<HTMLElement | null>): {
  isFullscreen: Ref<boolean>
  usesFallback: ComputedRef<boolean>
  toggle(): Promise<void>
} {
  const isFullscreen = ref(false)
  const nativeAvailable = typeof document !== 'undefined' && document.fullscreenEnabled === true
  // jsdom has no fullscreenEnabled, so suites always take the fallback path; that is intended.
  const usesFallback = computed(() => !nativeAvailable)

  async function toggle(): Promise<void> {
    if (!nativeAvailable) {
      // The fallback just flips the ref; StageFrame's `.fallback-fullscreen` CSS does the layout.
      isFullscreen.value = !isFullscreen.value
      return
    }
    if (document.fullscreenElement !== null) {
      // A refused transition (a request that was not a direct user gesture, a gesture disallowed by
      // the browser, an iframe permission, or a transient state) leaves isFullscreen exactly as the
      // fullscreenchange listener reports it, so it is safe to drop the rejection here.
      await document.exitFullscreen().catch(() => {})
    } else if (target.value !== null) {
      await target.value.requestFullscreen().catch(() => {})
    }
  }

  if (nativeAvailable) {
    document.addEventListener('fullscreenchange', onChange)
  } else {
    window.addEventListener('keydown', onFallbackKeydown)
  }

  function onChange(): void {
    isFullscreen.value = document.fullscreenElement !== null
  }

  function onFallbackKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && isFullscreen.value) {
      isFullscreen.value = false
    }
  }

  // While the fallback is active the stage is `position: fixed`, so lock the body to keep the
  // document from scrolling; restore it once the stage is fullscreen or the native API takes over.
  watch([isFullscreen, usesFallback], ([active, fallback]) => {
    if (document.body !== null) {
      document.body.style.overflow = active && fallback ? 'hidden' : ''
    }
  })

  onBeforeUnmount(() => {
    if (nativeAvailable) {
      document.removeEventListener('fullscreenchange', onChange)
      // Route navigation while fullscreen: hand control back to the browser before the stage goes.
      if (document.fullscreenElement !== null) {
        void document.exitFullscreen()
      }
    } else {
      window.removeEventListener('keydown', onFallbackKeydown)
    }
    isFullscreen.value = false
    if (document.body !== null) {
      document.body.style.overflow = ''
    }
  })

  return { isFullscreen, usesFallback, toggle }
}
