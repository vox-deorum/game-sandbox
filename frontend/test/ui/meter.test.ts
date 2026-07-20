import { render, screen } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'

import UiMeter from '../../src/components/ui/UiMeter.vue'

describe('UiMeter', () => {
  it('exposes the typed meter values and always renders its text value', () => {
    const { container } = render(UiMeter, {
      props: {
        value: 41600,
        max: 100000,
        label: 'Development budget used',
        textValue: '41.6k of 100k budget units used',
      },
    })

    expect(screen.getByRole('meter', { name: 'Development budget used' })).toHaveAttribute(
      'value',
      '41600',
    )
    expect(screen.getByRole('meter')).toHaveAttribute('max', '100000')
    expect(screen.getByText('41.6k of 100k budget units used')).toBeInTheDocument()
    expect(container.querySelector('.ui-meter .track')).not.toBeNull()
  })
})
