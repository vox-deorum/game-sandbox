import { fireEvent, render, screen } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'

import UiCheckboxGroup from '../../src/components/ui/UiCheckboxGroup.vue'

describe('UiCheckboxGroup', () => {
  it('labels its fieldset, wires help and errors, and emits selected values in option order', async () => {
    const { emitted } = render(UiCheckboxGroup, {
      props: {
        modelValue: ['night'],
        legend: 'Extras',
        hint: 'Choose any.',
        error: 'Choose a supported option.',
        options: [
          { value: 'wind', label: 'Wind' },
          { value: 'night', label: 'Night' },
        ],
      },
    })
    const group = screen.getByRole('group', { name: 'Extras' })
    expect(group).toHaveAttribute('aria-invalid', 'true')
    expect(group.getAttribute('aria-describedby')).toContain(screen.getByText('Choose any.').id)
    expect(group.getAttribute('aria-describedby')).toContain(screen.getByRole('alert').id)

    await fireEvent.click(screen.getByRole('checkbox', { name: 'Wind' }))
    expect(emitted()['update:modelValue']?.at(-1)).toEqual([['wind', 'night']])
  })
})
