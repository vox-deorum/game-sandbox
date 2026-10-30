/**
 * Render a scrolling log and keep its active row in view. DecisionLog uses it, with the latest tick on
 * a live log and the scrubbed tick on a replay as the active row. ChatPanel uses it with no active row,
 * so its log follows the latest message.
 *
 * A long game logs thousands of rows (a Three Branches day is over 7,000 decisions), and mounting every
 * row with its player tag makes loading heavy and scrubbing slow. Past VIRTUAL_LOG_THRESHOLD rows the
 * log mounts only the rows near the viewport, measuring each as it renders, and two spacer elements
 * stand in for the rest so the scrollbar still spans the whole game. A shorter log (every card game)
 * renders every row as a plain list.
 *
 * Bind `scroller` to the scroll container. In virtual mode, render a spacer of `padding.top` pixels
 * before the rows (bound to `listStart`, which marks where the rows begin below any header) and one of
 * `padding.bottom` pixels after them, and bind `measure` and `data-index` on each row.
 *
 * The log only notices a new array, so callers replace their entries rather than push into them.
 */
import { useVirtualizer } from '@tanstack/vue-virtual'
import { computed, ref, watch } from 'vue'

/** Logs longer than this render only the rows near the viewport. */
export const VIRTUAL_LOG_THRESHOLD = 1000

interface VirtualLogOptions<T> {
  items: () => readonly T[]
  key: (item: T) => string
  /** The row to keep centered, or -1 (no row for the active tick, or a live log) to follow the end. */
  activeIndex: () => number
  /** Rows rendered above the log's own (setup rows), whose count moves where the log begins. */
  leadingRows: () => number
  /** A row's expected height in pixels until it is measured. */
  estimateSize: (item: T) => number
}

export function useVirtualLog<T>({
  items,
  key,
  activeIndex,
  leadingRows,
  estimateSize,
}: VirtualLogOptions<T>) {
  const scroller = ref<HTMLElement | null>(null)
  const listStart = ref<HTMLElement | null>(null)
  const scrollMargin = ref(0)
  const virtual = computed(() => items().length > VIRTUAL_LOG_THRESHOLD)

  const virtualizer = useVirtualizer<HTMLElement, HTMLElement>(
    computed(() => {
      const list = items()
      return {
        enabled: virtual.value,
        count: list.length,
        getScrollElement: () => scroller.value,
        estimateSize: (index: number) => estimateSize(list[index] as T),
        getItemKey: (index: number) => key(list[index] as T),
        scrollMargin: scrollMargin.value,
        overscan: 10,
      }
    }),
  )

  const rows = computed(() => {
    const list = items()
    if (!virtual.value) {
      return list.map((item, index) => ({ index, item }))
    }
    return virtualizer.value
      .getVirtualItems()
      .flatMap(({ index }) => (index < list.length ? [{ index, item: list[index] as T }] : []))
  })

  const padding = computed(() => {
    if (!virtual.value) {
      return { top: 0, bottom: 0 }
    }
    const instance = virtualizer.value
    const visible = instance.getVirtualItems()
    const total = instance.getTotalSize()
    const first = visible[0]
    const last = visible.at(-1)
    if (first === undefined || last === undefined) {
      return { top: 0, bottom: total }
    }
    const margin = instance.options.scrollMargin
    return { top: first.start - margin, bottom: Math.max(total - (last.end - margin), 0) }
  })

  /** A row's template ref: registers the row so the virtualizer measures its real height. */
  function measure(el: unknown): void {
    if (virtual.value && (el === null || el instanceof HTMLElement)) {
      virtualizer.value.measureElement(el)
    }
  }

  // Keep the active row (or, with none, the end) in view: once the scroll container mounts, with rows
  // already in it, and whenever the rows or the active row change.
  function follow(): void {
    const count = items().length
    const index = activeIndex()
    const el = scroller.value
    if (el === null) {
      return
    }
    if (!virtual.value) {
      // Every row exists, so center the marked one directly (best-effort: jsdom has no layout).
      const active = el.querySelector<HTMLElement>('[data-active="true"]')
      el.scrollTop = active === null ? el.scrollHeight : active.offsetTop - el.clientHeight / 2
      return
    }
    if (listStart.value !== null) {
      scrollMargin.value = Math.round(
        listStart.value.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop,
      )
    }
    if (index < 0) {
      virtualizer.value.scrollToIndex(count - 1, { align: 'end' })
    } else {
      virtualizer.value.scrollToIndex(index, { align: 'center' })
    }
  }

  watch([scroller, () => items().length, activeIndex, leadingRows, virtual], follow, {
    flush: 'post',
  })

  return { scroller, listStart, rows, padding, measure, virtual }
}
