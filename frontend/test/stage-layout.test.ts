import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, type Ref, ref } from 'vue'

import { useStageLayout } from '../src/composables/useStageLayout.js'

/** A controllable `window.matchMedia` stand-in (jsdom ships none): records listeners and can flip. */
function mockMatchMedia(initial: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const mql = {
    matches: initial,
    media: '',
    addEventListener: (_: string, cb: (event: MediaQueryListEvent) => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: (event: MediaQueryListEvent) => void) =>
      listeners.delete(cb),
    /** Drive a viewport change, as a real media query would on resize across the breakpoint. */
    flip(next: boolean) {
      mql.matches = next
      for (const cb of listeners) {
        cb({ matches: next } as MediaQueryListEvent)
      }
    },
    listenerCount: () => listeners.size,
  }
  window.matchMedia = vi.fn(() => mql) as unknown as typeof window.matchMedia
  return mql
}

/** Mount the composable inside a throwaway component so its lifecycle hooks have an instance. */
function withStageLayout(aspectRatio: Ref<number | null>) {
  let layout!: ReturnType<typeof useStageLayout>
  const wrapper = mount(
    defineComponent({
      setup() {
        layout = useStageLayout(aspectRatio)
        return () => h('div')
      },
    }),
  )
  return { layout, wrapper }
}

afterEach(() => {
  // Restore jsdom's default (no matchMedia) so other suites see the unmodified environment.
  // @ts-expect-error deleting the stubbed property
  delete window.matchMedia
})

describe('useStageLayout', () => {
  it('places the log beside a portrait canvas regardless of viewport width', () => {
    mockMatchMedia(false) // narrow: would keep a landscape canvas stacked
    const { layout } = withStageLayout(ref<number | null>(288 / 512))
    expect(layout.portrait.value).toBe(true)
    expect(layout.logBeside.value).toBe(true)
  })

  it('stacks the log below a landscape canvas on a narrow viewport', () => {
    mockMatchMedia(false)
    const { layout } = withStageLayout(ref<number | null>(960 / 720))
    expect(layout.portrait.value).toBe(false)
    expect(layout.logBeside.value).toBe(false)
  })

  it('places the log beside a landscape canvas once the viewport is wide enough', () => {
    mockMatchMedia(true)
    const { layout } = withStageLayout(ref<number | null>(960 / 720))
    expect(layout.portrait.value).toBe(false)
    expect(layout.logBeside.value).toBe(true)
  })

  it('moves a landscape log beside the canvas reactively when the viewport crosses the breakpoint', () => {
    const mql = mockMatchMedia(false)
    const { layout } = withStageLayout(ref<number | null>(960 / 720))
    expect(layout.logBeside.value).toBe(false)
    mql.flip(true)
    expect(layout.logBeside.value).toBe(true)
  })

  it('is neither portrait nor beside before the renderer reports a shape', () => {
    mockMatchMedia(true)
    const { layout } = withStageLayout(ref<number | null>(null))
    expect(layout.portrait.value).toBe(false)
    expect(layout.logBeside.value).toBe(false)
  })

  it('drops its media-query listener on unmount', () => {
    const mql = mockMatchMedia(false)
    const { wrapper } = withStageLayout(ref<number | null>(960 / 720))
    expect(mql.listenerCount()).toBe(1)
    wrapper.unmount()
    expect(mql.listenerCount()).toBe(0)
  })
})
