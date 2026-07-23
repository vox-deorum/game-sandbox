// The small presentational primitives in one suite: badge, status badge, card, empty state.
import { fireEvent, render, screen } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'

import UiAvatar from '../../src/components/ui/UiAvatar.vue'
import UiBadge from '../../src/components/ui/UiBadge.vue'
import UiCard from '../../src/components/ui/UiCard.vue'
import UiDialogActions from '../../src/components/ui/UiDialogActions.vue'
import UiEmptyState from '../../src/components/ui/UiEmptyState.vue'
import UiStatusBadge from '../../src/components/ui/UiStatusBadge.vue'

describe('UiBadge', () => {
  it('renders its text', () => {
    render(UiBadge, { slots: { default: 'Human playable' } })
    expect(screen.getByText('Human playable')).toBeInTheDocument()
  })
})

describe('UiAvatar', () => {
  it('renders a labelled initial fallback when no image is available', () => {
    render(UiAvatar, { props: { name: 'Ada Lovelace' } })
    expect(screen.getByRole('img', { name: "Ada Lovelace's avatar" })).toHaveTextContent('A')
  })

  it('renders a labelled image in the profile size', () => {
    render(UiAvatar, {
      props: { name: 'Ada Lovelace', image: 'https://example.test/ada.png', size: 'profile' },
    })
    expect(screen.getByRole('img', { name: "Ada Lovelace's avatar" })).toHaveClass('profile')
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

describe('UiCard', () => {
  it('renders slot content', () => {
    render(UiCard, { slots: { default: 'Card body' } })
    expect(screen.getByText('Card body')).toBeInTheDocument()
  })
})

describe('UiDialogActions', () => {
  it('renders actions in the shared dialog footer', () => {
    const { container } = render(UiDialogActions, { slots: { default: 'Confirm and cancel' } })
    expect(screen.getByText('Confirm and cancel')).toBeInTheDocument()
    expect(container.querySelector('.ui-dialog-actions')).not.toBeNull()
  })
})

describe('UiEmptyState', () => {
  it('renders the muted message by default', () => {
    render(UiEmptyState, { slots: { default: 'No replays yet.' } })
    expect(screen.getByText('No replays yet.')).toBeInTheDocument()
  })

  it('renders the danger tone for errors', () => {
    const { container } = render(UiEmptyState, {
      props: { tone: 'danger' },
      slots: { default: 'Could not load.' },
    })
    expect(container.querySelector('.ui-empty-state.danger')).not.toBeNull()
  })
})
