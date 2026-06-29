/**
 * The stage's orientation/placement decision the session and replay pages share. The renderer reports
 * an `aspectRatio` (see useRendererMount); from it this derives whether the canvas is portrait and
 * whether the decision log sits beside it.
 *
 * A portrait canvas always leaves a free column, so the log sits beside it. A landscape canvas (Hearts)
 * fills the row, so the log only moves beside it once the viewport is wide enough to hold both the
 * canvas at a good size and the log column — below that width it stacks below the canvas. The width
 * test is a `matchMedia`, kept reactive through a ref so the pages need no resize listener of their own.
 */
import { computed, onBeforeUnmount, type Ref, ref } from 'vue'

/** Viewport width at which a landscape canvas gains room for the log beside it (within the 960px page
 *  content cap, this leaves a ~660px canvas next to a 16rem log). Tunable. */
const LANDSCAPE_BESIDE_MIN = '(min-width: 1200px)'

/**
 * Derive the stage's orientation (`portrait`) and whether the decision log sits beside the canvas
 * (`logBeside`) from the renderer's reported aspect ratio. Both are computed refs the page binds.
 */
export function useStageLayout(aspectRatio: Ref<number | null>) {
  // jsdom (the unit-test DOM) has no matchMedia; fall back to a non-matching query so a landscape
  // canvas stacks. The suites render portrait canvases, which are beside regardless, so they never
  // depend on the width test.
  const query =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(LANDSCAPE_BESIDE_MIN)
      : null

  const wideEnough = ref(query?.matches ?? false)
  const onChange = (event: MediaQueryListEvent): void => {
    wideEnough.value = event.matches
  }
  query?.addEventListener('change', onChange)
  onBeforeUnmount(() => query?.removeEventListener('change', onChange))

  const portrait = computed(() => aspectRatio.value !== null && aspectRatio.value < 1)
  // Portrait: always beside. Landscape: beside only once the viewport leaves room for both.
  const logBeside = computed(
    () => aspectRatio.value !== null && (portrait.value || wideEnough.value),
  )

  return { portrait, logBeside }
}
