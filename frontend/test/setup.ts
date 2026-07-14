// Extends Vitest's `expect` with the jest-dom matchers (toBeInTheDocument, toHaveTextContent, ...)
// used by the component suites, and unmounts each rendered component between tests. Loaded once
// before any test through vitest.config's setupFiles.
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/vue'
import { afterEach } from 'vitest'

afterEach(async () => {
  cleanup()
  // Import lazily so a suite's hoisted API mock is installed before the catalog captures its client.
  const { resetEnvironmentCatalog } = await import('../src/environmentCatalog.js')
  resetEnvironmentCatalog()
})

// jsdom has no ResizeObserver; Reka UI components (the dialog and slider primitives wrap them)
// measure elements through one at mount and hide parts until a measurement arrives (the slider
// thumb is display:none without it). The stub reports a fixed nonzero size synchronously on
// observe, which is enough because the suites assert on roles, values, and keyboard behavior,
// never on measured pixels.
if (typeof globalThis.ResizeObserver === 'undefined') {
  const fakeBoxes = [{ inlineSize: 16, blockSize: 16 }]
  class ResizeObserverStub {
    readonly #callback: ResizeObserverCallback
    constructor(callback: ResizeObserverCallback) {
      this.#callback = callback
    }
    observe(target: Element) {
      const entry = {
        target,
        contentRect: { width: 16, height: 16, x: 0, y: 0, top: 0, left: 0, right: 16, bottom: 16 },
        borderBoxSize: fakeBoxes,
        contentBoxSize: fakeBoxes,
        devicePixelContentBoxSize: fakeBoxes,
      } as unknown as ResizeObserverEntry
      this.#callback([entry], this as unknown as ResizeObserver)
    }
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
}

// jsdom exposes canvas elements but no rasterizer. Returning null matches browsers that cannot
// provide a 2D context and keeps renderer input tests from printing jsdom's not-implemented warning.
if (typeof HTMLCanvasElement !== 'undefined') {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => null,
  })
}
