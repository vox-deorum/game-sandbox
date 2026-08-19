import { fireEvent, render, screen } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'

import UiDialog from '../../src/components/ui/UiDialog.vue'

// The dialog is controlled by the parent through v-model:open, so the harness owns the ref the
// way the environment page will.
function makeHarness(open: boolean) {
  const openRef = ref(open)
  const Harness = defineComponent(() => {
    return () =>
      h(
        UiDialog,
        {
          open: openRef.value,
          'onUpdate:open': (v: boolean) => {
            openRef.value = v
          },
          title: 'Start session',
          description: 'Configure and start.',
        },
        { default: () => h('p', 'Body content') },
      )
  })
  return { Harness, openRef }
}

describe('UiDialog', () => {
  // The open-dialog queries are async (findBy*) because Reka teleports the content to body one
  // tick after mount.
  it('renders nothing while closed', async () => {
    const { Harness } = makeHarness(false)
    render(Harness)
    await nextTick()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('renders a modal dialog with its title, description, and body when open', async () => {
    const { Harness } = makeHarness(true)
    render(Harness)
    const dialog = await screen.findByRole('dialog')
    // Reka marks modality by aria-hiding everything outside the dialog, not with aria-modal; the
    // labelled-by wiring is what we assert on.
    expect(dialog).toHaveAttribute('aria-labelledby')
    expect(screen.getByText('Start session')).toBeInTheDocument()
    expect(screen.getByText('Configure and start.')).toBeInTheDocument()
    expect(screen.getByText('Body content')).toBeInTheDocument()
  })

  it('closes on escape', async () => {
    const { Harness, openRef } = makeHarness(true)
    render(Harness)
    await fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' })
    expect(openRef.value).toBe(false)
  })

  it('renders a header X close button and closes when it is clicked', async () => {
    const { Harness, openRef } = makeHarness(true)
    render(Harness)
    const close = await screen.findByRole('button', { name: 'Close' })
    expect(close).toHaveClass('ui-dialog-close')
    await fireEvent.click(close)
    expect(openRef.value).toBe(false)
  })
})
