import { fireEvent, render, screen, within } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import UiConfirmDialog from '../../src/components/ui/UiConfirmDialog.vue'
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

  it('keeps a non-dismissible dialog open on escape and hides its close button', async () => {
    const openRef = ref(true)
    const Harness = defineComponent(
      () => () =>
        h(UiDialog, {
          open: openRef.value,
          'onUpdate:open': (v: boolean) => (openRef.value = v),
          title: 'Locked',
          dismissible: false,
        }),
    )
    render(Harness)
    const dialog = await screen.findByRole('dialog')
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()
    await fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(openRef.value).toBe(true)
  })

  it('emits confirm and secondary without closing, while cancel closes by itself', async () => {
    const events: string[] = []
    const openRef = ref(true)
    const Harness = defineComponent(
      () => () =>
        h(
          UiConfirmDialog,
          {
            open: openRef.value,
            'onUpdate:open': (v: boolean) => (openRef.value = v),
            title: 'Confirm',
            confirmLabel: 'Start new',
            confirmVariant: 'danger',
            secondaryLabel: 'Return',
            cancelLabel: 'Cancel',
            onConfirm: () => events.push('confirm'),
            onSecondary: () => events.push('secondary'),
            onCancel: () => events.push('cancel'),
          },
          { default: () => h('p', 'Body') },
        ),
    )
    render(Harness)
    const dialog = await screen.findByRole('dialog')
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Start new' }))
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Return' }))
    expect(events).toEqual(['confirm', 'secondary'])
    expect(openRef.value).toBe(true)

    // Cancel is the paired "no": it closes the dialog itself, so callers only handle extra cleanup.
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(events).toEqual(['confirm', 'secondary', 'cancel'])
    expect(openRef.value).toBe(false)
  })

  it('forwards the header X close through the confirmation model', async () => {
    const openRef = ref(true)
    const Harness = defineComponent(
      () => () =>
        h(UiConfirmDialog, {
          open: openRef.value,
          'onUpdate:open': (v: boolean) => (openRef.value = v),
          title: 'Confirm',
          confirmLabel: 'Confirm',
        }),
    )
    render(Harness)
    const dialog = await screen.findByRole('dialog')
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(openRef.value).toBe(false)
  })

  it('keeps a non-dismissible confirmation open on outside interaction', async () => {
    const openRef = ref(true)
    const Harness = defineComponent(
      () => () =>
        h(UiConfirmDialog, {
          open: openRef.value,
          'onUpdate:open': (v: boolean) => (openRef.value = v),
          title: 'Locked',
          confirmLabel: 'Confirm',
          dismissible: false,
        }),
    )
    render(Harness)
    await screen.findByRole('dialog')
    await fireEvent.pointerDown(document.body)
    expect(openRef.value).toBe(true)
  })

  it('shows errors and prevents busy or disabled actions from emitting', async () => {
    const events: string[] = []
    const Harness = defineComponent(
      () => () =>
        h(UiConfirmDialog, {
          open: true,
          title: 'Busy confirmation',
          confirmLabel: 'Confirm',
          confirmLoading: true,
          secondaryLabel: 'Other action',
          secondaryDisabled: true,
          cancelLabel: 'Cancel',
          cancelDisabled: true,
          error: 'The operation failed.',
          onConfirm: () => events.push('confirm'),
          onSecondary: () => events.push('secondary'),
          onCancel: () => events.push('cancel'),
        }),
    )
    render(Harness)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('alert')).toHaveTextContent('The operation failed.')
    expect(within(dialog).getByRole('button', { name: 'Confirm' })).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: 'Other action' })).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }))
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Other action' }))
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(events).toEqual([])
  })
})
