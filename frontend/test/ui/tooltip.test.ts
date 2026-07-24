// The UiTooltip primitive on its own: the trigger's naming and association, opening on hover and on
// focus, and the inspectable variant. The composed LLM cost tooltip's own behavior (pinning, escape,
// staying open across the gap to the bubble) lives in llm-components.test.ts.
import { fireEvent, render, screen } from '@testing-library/vue'
import { describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'

import UiTooltip from '../../src/components/ui/UiTooltip.vue'

const Harness = defineComponent({
  components: { UiTooltip },
  props: { inspectable: { type: Boolean, default: false } },
  emits: ['inspect'],
  template: `
    <UiTooltip label="2 settings" accessible-label="Show settings details" :inspectable="inspectable"
      @inspect="$emit('inspect')">
      <template #content><p>Pipe gap 90</p></template>
    </UiTooltip>
  `,
})

describe('UiTooltip', () => {
  it('names the trigger, mounts nothing until hover, and associates the bubble it opens', async () => {
    render(Harness)
    const trigger = screen.getByRole('button', { name: 'Show settings details' })
    expect(trigger).toHaveTextContent('2 settings')
    expect(screen.queryByRole('tooltip')).toBeNull()

    await fireEvent.mouseEnter(trigger.parentElement as HTMLElement)
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent('Pipe gap 90')
    expect(tooltip.id).toBe(trigger.getAttribute('aria-describedby'))
    expect(trigger).not.toHaveAttribute('aria-haspopup')
  })

  it('opens on keyboard focus so the bubble is reachable without a pointer', async () => {
    render(Harness)
    const trigger = screen.getByRole('button', { name: 'Show settings details' })
    await fireEvent.focus(trigger)
    expect(screen.getByRole('tooltip')).toBeVisible()
  })

  it('emits inspect instead of pinning when the trigger opens a fuller view', async () => {
    const onInspect = vi.fn()
    render(Harness, { props: { inspectable: true }, attrs: { onInspect } })
    const trigger = screen.getByRole('button', { name: 'Show settings details' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')

    await fireEvent.click(trigger)
    expect(onInspect).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
