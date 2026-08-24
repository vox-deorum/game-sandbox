import { fireEvent, render, screen } from '@testing-library/vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import UiCodeBlock from '../src/components/ui/UiCodeBlock.vue'

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('UiCodeBlock', () => {
  it('shows the code and copies the exact text', async () => {
    const writeText = vi.fn(async () => {})
    stubClipboard(writeText)
    render(UiCodeBlock, { props: { code: 'line one\nline two', copyLabel: 'Copy commands' } })

    expect(screen.getByText(/line one/)).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Copy commands' }))

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('line one\nline two')
    expect(screen.getByRole('status')).toHaveTextContent('Copied.')
  })

  it('announces a failed copy and returns to idle afterward', async () => {
    vi.useFakeTimers()
    stubClipboard(() => Promise.reject(new Error('denied')))
    render(UiCodeBlock, { props: { code: 'secret' } })

    await fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Copy failed.')

    vi.advanceTimersByTime(2000)
    await nextTick()
    expect(status).toBeEmptyDOMElement()
  })
})
