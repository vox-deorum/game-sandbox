import { fireEvent, render, screen } from '@testing-library/vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import StageFrame from '../src/components/StageFrame.vue'

/** Native Fullscreen API shim: jsdom ships none, so install `fullscreenEnabled`, the element
 *  methods, and `fullscreenElement` state that dispatch `fullscreenchange` to the real listener.
 *  The stage canvas is a <section>, so the request method must live on `HTMLElement` (not
 *  `HTMLDivElement`). */
function mockFullscreen() {
  let element: Element | null = null
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true })
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => element })
  Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
    configurable: true,
    value: vi.fn(function (this: HTMLElement) {
      element = this
      document.dispatchEvent(new Event('fullscreenchange'))
      return Promise.resolve()
    }),
  })
  Object.defineProperty(document, 'exitFullscreen', {
    configurable: true,
    value: vi.fn(() => {
      element = null
      document.dispatchEvent(new Event('fullscreenchange'))
      return Promise.resolve()
    }),
  })
}

afterEach(() => {
  vi.useRealTimers()
  // Restore jsdom's defaults (no Fullscreen API) so the remaining tests in this file take the
  // fallback path. `fullscreenElement` becomes a null getter rather than being deleted so the still
  // mounted native-mode component unmounts cleanly once the stubs are gone.
  // @ts-expect-error deleting the stubbed property
  delete document.fullscreenEnabled
  // @ts-expect-error deleting the stubbed method
  delete document.exitFullscreen
  // @ts-expect-error deleting the stubbed method
  delete HTMLElement.prototype.requestFullscreen
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null })
})

describe('StageFrame', () => {
  it('owns the renderer host and forwards keyboard events from the labeled stage', async () => {
    const onRendererHost = vi.fn()
    const onKeydown = vi.fn()
    const view = render(StageFrame, {
      props: {
        aspectRatio: 0.75,
        logBeside: true,
        canvasLabel: 'Environment',
        stageLabel: 'Game stage',
        besideLogLabel: 'Decision log',
        onRendererHost,
        onKeydown,
      },
      slots: {
        overlay: '<span>Paused</span>',
        'beside-log': '<p>Decisions</p>',
        'below-log': '<details><summary>Chat</summary></details>',
      },
    })

    const stage = screen.getByRole('group', { name: 'Game stage' })
    expect(stage).toHaveClass('portrait', 'beside')
    expect(screen.getByText('Decisions').closest('section')).toHaveAttribute(
      'aria-label',
      'Decision log',
    )
    expect(onRendererHost.mock.calls[0]?.[0]).toBeInstanceOf(HTMLElement)

    await fireEvent.keyDown(stage, { key: 'ArrowRight' })
    expect(onKeydown).toHaveBeenCalledOnce()

    view.unmount()
    expect(onRendererHost).toHaveBeenLastCalledWith(null)
  })

  it('replaces log content with the shared loading status', () => {
    render(StageFrame, {
      props: {
        aspectRatio: null,
        logBeside: false,
        loading: true,
        loadingLabel: 'Loading replay…',
        canvasLabel: 'Replay',
      },
      slots: { 'below-log': '<p>Hidden log</p>' },
    })

    expect(screen.getByRole('status')).toHaveTextContent('Loading replay…')
    expect(screen.queryByText('Hidden log')).toBeNull()
  })

  it('drives the native Fullscreen API through the toggle', async () => {
    mockFullscreen()
    const view = render(StageFrame, {
      props: { aspectRatio: 0.75, logBeside: true, canvasLabel: 'Environment' },
    })
    const stageCanvas = view.container.querySelector('.stage-canvas') as HTMLElement

    await fireEvent.click(screen.getByRole('button', { name: 'Enter full screen' }))
    // The browser reports the canvas as the fullscreen element and syncs the section's classes.
    expect(document.fullscreenElement).toBe(stageCanvas)
    expect(stageCanvas).toHaveClass('is-fullscreen')
    expect(stageCanvas).not.toHaveClass('fallback-fullscreen')
    expect(screen.getByRole('button', { name: 'Exit full screen' })).toBeInTheDocument()

    await fireEvent.click(screen.getByRole('button', { name: 'Exit full screen' }))
    expect(document.fullscreenElement).toBeNull()
    expect(stageCanvas).not.toHaveClass('is-fullscreen')
    expect(screen.getByRole('button', { name: 'Enter full screen' })).toBeInTheDocument()
  })

  it('falls back to the fixed-overlay CSS when the native API is unavailable', async () => {
    const view = render(StageFrame, {
      props: { aspectRatio: 0.75, logBeside: true, canvasLabel: 'Environment' },
    })
    const stageCanvas = view.container.querySelector('.stage-canvas') as HTMLElement

    await fireEvent.click(screen.getByRole('button', { name: 'Enter full screen' }))
    // No Fullscreen API in plain jsdom: the fallback pins the canvas and locks the body scroll.
    expect(stageCanvas).toHaveClass('is-fullscreen', 'fallback-fullscreen')
    expect(document.body.style.overflow).toBe('hidden')
    expect(screen.getByRole('button', { name: 'Exit full screen' })).toBeInTheDocument()

    await fireEvent.keyDown(window, { key: 'Escape' })
    expect(stageCanvas).not.toHaveClass('is-fullscreen', 'fallback-fullscreen')
    expect(document.body.style.overflow).toBe('')
    expect(screen.getByRole('button', { name: 'Enter full screen' })).toBeInTheDocument()
  })

  it('auto-hides the fullscreen controls after an idle interval and reveals on activity', async () => {
    vi.useFakeTimers()
    const view = render(StageFrame, {
      props: { aspectRatio: 0.75, logBeside: true, canvasLabel: 'Environment' },
    })
    const stageCanvas = view.container.querySelector('.stage-canvas') as HTMLElement

    await fireEvent.click(screen.getByRole('button', { name: 'Enter full screen' }))
    // The idle timer arms on pointer activity once fullscreen, as real cursor presence would.
    await fireEvent.pointerMove(stageCanvas)

    vi.advanceTimersByTime(2501)
    await nextTick()
    expect(stageCanvas).toHaveClass('is-fullscreen', 'controls-idle')

    await fireEvent.pointerMove(stageCanvas)
    await nextTick()
    expect(stageCanvas).not.toHaveClass('controls-idle')
  })
})
