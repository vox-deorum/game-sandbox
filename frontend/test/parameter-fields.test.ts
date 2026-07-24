import type { EnvParameter, ParameterValue } from '@game-sandbox/schema/environment'
import { fireEvent, render, screen, waitFor } from '@testing-library/vue'
import { describe, expect, it, vi } from 'vitest'

import ParameterFields from '../src/components/ParameterFields.vue'

const DECLARATIONS: EnvParameter[] = [
  {
    name: 'seats',
    title: 'Seats',
    description: 'Players.',
    type: 'int',
    default: 1,
    min: 1,
    max: 1,
  },
  {
    name: 'pipe_gap',
    title: 'Pipe gap',
    description: 'Vertical opening between pipes.',
    type: 'int',
    default: 100,
    min: 60,
    max: 200,
  },
  { name: 'enabled', title: 'Wind', description: 'Enable wind.', type: 'bool', default: false },
]

describe('ParameterFields', () => {
  it('renders visible controls, preserves hidden values, and emits normalized edits', async () => {
    const update = vi.fn<(value: Record<string, ParameterValue>) => void>()
    render(ParameterFields, {
      props: {
        declarations: DECLARATIONS,
        modelValue: { seats: 1, pipe_gap: 90, enabled: false },
        'onUpdate:modelValue': update,
      },
    })
    expect(screen.queryByLabelText('Seats')).toBeNull()
    expect(screen.getByLabelText('Pipe gap')).toHaveValue(90)
    expect(screen.getByLabelText('Wind')).toHaveDisplayValue('Off')
    await fireEvent.update(screen.getByLabelText('Pipe gap'), '110')
    expect(update).toHaveBeenLastCalledWith({ seats: 1, pipe_gap: 110, enabled: false })
  })

  it('explains a blank numeric value and reports the form invalid', async () => {
    const validity = vi.fn<(valid: boolean) => void>()
    render(ParameterFields, {
      props: {
        declarations: DECLARATIONS,
        modelValue: { seats: 1, pipe_gap: 90, enabled: false },
        onValidity: validity,
      },
    })
    await fireEvent.update(screen.getByLabelText('Pipe gap'), '')
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    await waitFor(() => expect(validity).toHaveBeenLastCalledWith(false))
  })
})
