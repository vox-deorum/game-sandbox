import { fireEvent, render, screen } from '@testing-library/vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import UiToast from '../../src/components/ui/UiToast.vue'
import { useToast } from '../../src/toast.js'

// The toast queue is a module singleton, so the suite drives it directly through useToast and drains
// it between tests; fake timers keep the auto-dismiss timers out of the real clock.
describe('UiToast', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    const { toasts, dismiss } = useToast()
    for (const toast of toasts) {
      dismiss(toast.id)
    }
    vi.useRealTimers()
  })

  it('renders a pushed toast as a status region', () => {
    const { show } = useToast()
    show("Guest accounts can't submit agents.")
    render(UiToast)
    const toast = screen.getByRole('status')
    expect(toast).toHaveTextContent("Guest accounts can't submit agents.")
  })

  it('dismisses a toast on click', async () => {
    const { show } = useToast()
    show('Click me to dismiss')
    render(UiToast)
    const toast = screen.getByRole('status')
    await fireEvent.click(toast)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('auto-dismisses after a few seconds', async () => {
    const { show } = useToast()
    show('A passing notice')
    render(UiToast)
    expect(screen.getByRole('status')).toBeInTheDocument()
    await vi.advanceTimersByTimeAsync(4000)
    expect(screen.queryByRole('status')).toBeNull()
  })
})
