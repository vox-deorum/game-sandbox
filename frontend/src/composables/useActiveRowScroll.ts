/**
 * Follow the active row of a scrolling list: center the `[data-active="true"]` element as the row count
 * or the active index changes, falling back to the bottom when nothing is active. Shared by DecisionLog
 * and GameThread, whose active-row scroll behavior is identical (the latest tick on a live log, the
 * scrubbed tick on a replay). Best-effort: jsdom has no layout so this is a no-op there, but it never
 * throws. Bind the returned ref to the scroll container's `ref`.
 */
import { type Ref, ref, watch } from 'vue'

export function useActiveRowScroll(
  count: () => number,
  activeIndex: () => number,
): Ref<HTMLElement | null> {
  const scroller = ref<HTMLElement | null>(null)
  watch(
    [count, activeIndex],
    () => {
      const el = scroller.value
      if (el === null) {
        return
      }
      const active = el.querySelector<HTMLElement>('[data-active="true"]')
      el.scrollTop = active === null ? el.scrollHeight : active.offsetTop - el.clientHeight / 2
    },
    { flush: 'post' },
  )
  return scroller
}
