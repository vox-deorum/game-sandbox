import { render, screen } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'

import UiCard from '../../src/components/ui/UiCard.vue'

describe('UiCard', () => {
  it('uses the default surface unless a variant is selected', () => {
    render(UiCard, { slots: { default: 'Ordinary card' } })
    expect(screen.getByText('Ordinary card')).toHaveClass('ui-card', 'default', 'padded')
  })

  it('exposes the info surface variant', () => {
    render(UiCard, { props: { variant: 'info' }, slots: { default: 'Useful context' } })
    expect(screen.getByText('Useful context')).toHaveClass('ui-card', 'info', 'padded')
  })
})
