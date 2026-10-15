import { fireEvent, render, screen } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'

import UiAvatar from '../../src/components/ui/UiAvatar.vue'
import UiStatusBadge from '../../src/components/ui/UiStatusBadge.vue'

describe('UiAvatar', () => {
  it('renders a labelled initial fallback when no image is available', () => {
    render(UiAvatar, { props: { name: 'Ada Lovelace' } })
    expect(screen.getByRole('img', { name: "Ada Lovelace's avatar" })).toHaveTextContent('A')
  })

  it('renders the supplied labelled image', () => {
    render(UiAvatar, {
      props: { name: 'Ada Lovelace', image: 'https://example.test/ada.png', size: 'profile' },
    })
    expect(screen.getByRole('img', { name: "Ada Lovelace's avatar" })).toHaveAttribute(
      'src',
      'https://example.test/ada.png',
    )
  })

  it('falls back to the initial when its image cannot load', async () => {
    render(UiAvatar, { props: { name: 'Ada Lovelace', image: 'https://example.test/ada.png' } })
    await fireEvent.error(screen.getByRole('img', { name: "Ada Lovelace's avatar" }))
    expect(screen.getByRole('img', { name: "Ada Lovelace's avatar" })).toHaveTextContent('A')
  })
})

describe('UiStatusBadge', () => {
  it('always carries a text label next to the dot', () => {
    render(UiStatusBadge, { props: { tone: 'success', label: 'running' } })
    expect(screen.getByText('running')).toBeInTheDocument()
  })

  it('hides the decorative dot from assistive tech', () => {
    const { container } = render(UiStatusBadge, { props: { label: 'idle' } })
    const dot = container.querySelector('.dot')
    expect(dot).toHaveAttribute('aria-hidden', 'true')
  })
})
