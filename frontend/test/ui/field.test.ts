import { render, screen } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'
import { defineComponent, h, ref } from 'vue'

import UiField from '../../src/components/ui/UiField.vue'
import UiInput from '../../src/components/ui/UiInput.vue'
import UiTextarea from '../../src/components/ui/UiTextarea.vue'

// A field with its input wired through the scoped slot, the way pages use the pair. Render
// functions instead of a template string because the test build has no runtime template compiler.
function makeHarness(fieldProps: { label: string; hint?: string; error?: string }) {
  return defineComponent(() => {
    const value = ref<string | number>('')
    return () =>
      h(UiField, fieldProps, {
        default: ({
          id,
          describedby,
          invalid,
        }: {
          id: string
          describedby?: string
          invalid: boolean
        }) =>
          h(UiInput, {
            id,
            'aria-describedby': describedby,
            invalid,
            modelValue: value.value,
            'onUpdate:modelValue': (v: string | number) => {
              value.value = v
            },
          }),
      })
  })
}

function makeTextareaHarness() {
  return defineComponent(() => {
    const value = ref('')
    return () =>
      h(
        UiField,
        { label: 'Notes', error: 'Enter one paragraph.' },
        {
          default: ({
            id,
            describedby,
            invalid,
          }: {
            id: string
            describedby?: string
            invalid: boolean
          }) =>
            h(UiTextarea, {
              id,
              rows: 3,
              maxlength: 200,
              disabled: true,
              'aria-describedby': describedby,
              invalid,
              modelValue: value.value,
              'onUpdate:modelValue': (v: string) => {
                value.value = v
              },
            }),
        },
      )
  })
}

describe('UiField', () => {
  it('associates the label with the slotted input', () => {
    render(makeHarness({ label: 'Seed' }))
    expect(screen.getByLabelText('Seed')).toBeInTheDocument()
  })

  it('wires the hint through aria-describedby', () => {
    render(makeHarness({ label: 'Seed', hint: 'Optional.' }))
    const input = screen.getByLabelText('Seed')
    const hint = screen.getByText('Optional.')
    expect(input.getAttribute('aria-describedby')).toBe(hint.id)
  })

  it('shows the error, marks the input invalid, and describes it', () => {
    render(makeHarness({ label: 'Timeout', hint: 'Milliseconds.', error: 'Must be positive.' }))
    const input = screen.getByLabelText('Timeout')
    const error = screen.getByText('Must be positive.')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toBe(error)
    // Both the hint and the error describe the input, in that order.
    const describedby = input.getAttribute('aria-describedby') ?? ''
    expect(describedby.split(' ')).toContain(error.id)
    expect(describedby.split(' ')).toContain(screen.getByText('Milliseconds.').id)
  })

  it('sets no aria-describedby when there is nothing to describe', () => {
    render(makeHarness({ label: 'Seed' }))
    expect(screen.getByLabelText('Seed')).not.toHaveAttribute('aria-describedby')
  })

  it('passes textarea attributes through and exposes invalid and disabled states', () => {
    render(makeTextareaHarness())
    const textarea = screen.getByLabelText('Notes')
    expect(textarea.tagName).toBe('TEXTAREA')
    expect(textarea).toHaveAttribute('rows', '3')
    expect(textarea).toHaveAttribute('maxlength', '200')
    expect(textarea).toHaveAttribute('aria-invalid', 'true')
    expect(textarea).toBeDisabled()
  })
})
