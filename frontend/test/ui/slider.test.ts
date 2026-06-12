import { fireEvent, render, screen } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'
import { defineComponent, h, ref } from 'vue'

import UiSlider from '../../src/components/ui/UiSlider.vue'

function makeHarness(initial: number, max: number) {
  const value = ref(initial)
  const Harness = defineComponent(() => {
    return () =>
      h(UiSlider, {
        modelValue: value.value,
        'onUpdate:modelValue': (v: number) => {
          value.value = v
        },
        label: 'Position',
        max,
      })
  })
  return { Harness, value }
}

describe('UiSlider', () => {
  // The queries are async (findBy*) because the thumb resolves its collection index, and with it
  // its value and visibility, one tick after mount.
  it('exposes the slider role with its value and bounds', async () => {
    const { Harness } = makeHarness(120, 300)
    render(Harness)
    const slider = await screen.findByRole('slider', { name: 'Position' })
    expect(slider).toHaveAttribute('aria-valuenow', '120')
    expect(slider).toHaveAttribute('aria-valuemin', '0')
    expect(slider).toHaveAttribute('aria-valuemax', '300')
  })

  it('steps with the arrow keys and jumps with Home and End', async () => {
    const { Harness, value } = makeHarness(120, 300)
    render(Harness)
    const slider = await screen.findByRole('slider', { name: 'Position' })
    await fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(value.value).toBe(121)
    await fireEvent.keyDown(slider, { key: 'ArrowLeft' })
    expect(value.value).toBe(120)
    await fireEvent.keyDown(slider, { key: 'End' })
    expect(value.value).toBe(300)
    await fireEvent.keyDown(slider, { key: 'Home' })
    expect(value.value).toBe(0)
  })
})
