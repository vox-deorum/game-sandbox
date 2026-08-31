import { fireEvent, render, screen } from '@testing-library/vue'
import { describe, expect, it, vi } from 'vitest'

import SessionStartOverlay from '../src/components/SessionStartOverlay.vue'

describe('SessionStartOverlay', () => {
  it('owns Start readiness and loading without leaking renderer events', async () => {
    const view = render(SessionStartOverlay, { props: { ready: false, pending: false } })
    const start = screen.getByRole('button', { name: 'Start' })
    expect(start).toBeDisabled()

    await view.rerender({ ready: true, pending: false })
    const parentEvents = {
      pointerdown: vi.fn(),
      touchstart: vi.fn(),
      click: vi.fn(),
      dblclick: vi.fn(),
    }
    for (const [name, listener] of Object.entries(parentEvents)) {
      view.container.addEventListener(name, listener)
    }

    await fireEvent.pointerDown(start)
    await fireEvent.touchStart(start)
    await fireEvent.click(start)
    await fireEvent.dblClick(start)

    expect(view.emitted().start).toHaveLength(1)
    for (const listener of Object.values(parentEvents)) {
      expect(listener).not.toHaveBeenCalled()
    }

    await view.rerender({ ready: true, pending: true })
    expect(start).toBeDisabled()
    expect(start).toHaveAttribute('aria-busy', 'true')
  })
})
