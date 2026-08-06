import type { EnvParameter, EnvPreset, ParameterValue } from '@game-sandbox/schema/environment'
import { fireEvent, render, screen, waitFor } from '@testing-library/vue'
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

import ParameterFields from '../src/components/ParameterFields.vue'

const DECLARATIONS: EnvParameter[] = [
  {
    name: 'players',
    title: 'Players',
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

const PRESETS: EnvPreset[] = [
  { name: 'narrow', title: 'Narrow gap', values: { pipe_gap: 70, enabled: true } },
  { name: 'wide', title: 'Wide gap', values: { pipe_gap: 180, enabled: false } },
]

describe('ParameterFields', () => {
  it('renders visible controls, preserves hidden values, and emits normalized edits', async () => {
    const update = vi.fn<(value: Record<string, ParameterValue>) => void>()
    render(ParameterFields, {
      props: {
        declarations: DECLARATIONS,
        modelValue: { players: 1, pipe_gap: 90, enabled: false },
        'onUpdate:modelValue': update,
      },
    })
    expect(screen.queryByLabelText('Seats')).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Preset' })).toBeNull()
    expect(screen.getByLabelText('Pipe gap')).toHaveValue(90)
    expect(screen.getByLabelText('Wind')).toHaveDisplayValue('Off')
    await fireEvent.update(screen.getByLabelText('Pipe gap'), '110')
    expect(update).toHaveBeenLastCalledWith({ players: 1, pipe_gap: 110, enabled: false })
  })

  it('explains a blank numeric value and reports the form invalid', async () => {
    const validity = vi.fn<(valid: boolean) => void>()
    render(ParameterFields, {
      props: {
        declarations: DECLARATIONS,
        modelValue: { players: 1, pipe_gap: 90, enabled: false },
        onValidity: validity,
      },
    })
    await fireEvent.update(screen.getByLabelText('Pipe gap'), '')
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    await waitFor(() => expect(validity).toHaveBeenLastCalledWith(false))
  })

  it('applies a preset by replacing the complete parameter map', async () => {
    const update = vi.fn<(value: Record<string, ParameterValue>) => void>()
    const validity = vi.fn<(valid: boolean) => void>()
    render(ParameterFields, {
      props: {
        declarations: DECLARATIONS,
        presets: PRESETS,
        modelValue: { players: 1, pipe_gap: 70, enabled: true },
        'onUpdate:modelValue': update,
        onValidity: validity,
      },
    })

    const preset = screen.getByRole('combobox', { name: 'Preset' })
    expect(preset).toHaveDisplayValue('Choose a preset')
    await fireEvent.update(preset, 'wide')
    expect(update).toHaveBeenLastCalledWith({ players: 1, pipe_gap: 180, enabled: false })
    expect(validity).toHaveBeenLastCalledWith(true)
  })

  it('keeps hand edits made after a preset fill', async () => {
    const fields = {
      components: { ParameterFields },
      setup() {
        const values = ref<Record<string, ParameterValue>>({
          players: 1,
          pipe_gap: 90,
          enabled: false,
        })
        return { values, declarations: DECLARATIONS, presets: PRESETS }
      },
      template:
        '<ParameterFields v-model="values" :declarations="declarations" :presets="presets" />',
    }
    render(fields)

    const preset = screen.getByRole('combobox', { name: 'Preset' })
    await fireEvent.update(preset, 'narrow')
    expect(preset).toHaveDisplayValue('Narrow gap')
    expect(screen.getByRole('spinbutton', { name: 'Pipe gap' })).toHaveValue(70)
    await fireEvent.update(screen.getByRole('spinbutton', { name: 'Pipe gap' }), '80')
    expect(screen.getByRole('spinbutton', { name: 'Pipe gap' })).toHaveValue(80)
    expect(screen.getByLabelText('Wind')).toHaveDisplayValue('On')
  })

  it('disables the preset selector with the parameter controls', () => {
    render(ParameterFields, {
      props: {
        declarations: DECLARATIONS,
        presets: PRESETS,
        modelValue: { players: 1, pipe_gap: 70, enabled: true },
        disabled: true,
      },
    })

    expect(screen.getByRole('combobox', { name: 'Preset' })).toBeDisabled()
  })
})
