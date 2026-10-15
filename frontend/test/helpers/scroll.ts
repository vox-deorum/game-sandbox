/**
 * A scroll container for jsdom, which has no layout: every element reports a tall scroll height, and
 * `scrollTo` moves `scrollTop` and fires the scroll event a browser would. Enough for the long-log
 * suites to watch a virtualized log follow its active row. Call the returned function to restore.
 */
import { vi } from 'vitest'

export function stubScrolling(scrollHeight = 1_000_000): () => void {
  const offsets = new WeakMap<Element, number>()
  const height = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(scrollHeight)
  const top = vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(function (
    this: Element,
  ) {
    return offsets.get(this) ?? 0
  })
  const original = Element.prototype.scrollTo
  Element.prototype.scrollTo = function (this: Element, options?: ScrollToOptions | number) {
    if (typeof options === 'object' && options.top !== undefined) {
      offsets.set(this, options.top)
      this.dispatchEvent(new Event('scroll'))
    }
  } as typeof Element.prototype.scrollTo
  return () => {
    height.mockRestore()
    top.mockRestore()
    Element.prototype.scrollTo = original
  }
}
