// Smoke test: the styleguide page renders every primitive section without error. The page is the
// definition of done for primitive variants, so this suite fails when a section breaks at mount.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

import StyleguidePage from '../../src/pages/StyleguidePage.vue'

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
}

describe('StyleguidePage', () => {
  it('renders all primitive sections', async () => {
    render(StyleguidePage, { global: { plugins: [makeRouter()] } })
    expect(await screen.findByRole('heading', { name: 'Styleguide' })).toBeInTheDocument()
    for (const section of [
      'Color tokens',
      'Spacing',
      'Type scale',
      'UiButton',
      'UiBadge',
      'UiAvatar',
      'UiStatusBadge',
      'UiCard',
      'UiField and UiInput',
      'UiSelect',
      'UiTextarea',
      'Season LLM controls',
      'UiTabs',
      'UiDialog',
      'UiConfirmDialog',
      'UiSlider',
      'UiMeter',
      'UiTooltip',
      'UiEmptyState',
      'UiToast',
    ]) {
      expect(screen.getByRole('heading', { name: section })).toBeInTheDocument()
    }
    expect(screen.getByText('An info card for short guidance or summaries.')).toHaveClass(
      'ui-card',
      'info',
    )

    await fireEvent.click(screen.getByRole('button', { name: 'Open dialog' }))
    expect((await screen.findByRole('dialog')).querySelector('.ui-dialog-actions')).not.toBeNull()
    await fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' })
    // Reka unmounts the closed dialog a tick later, and the page behind stays aria-hidden until it
    // does, so wait before reaching for the next demo's trigger.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    // The danger confirmation demo carries the variant set production uses: danger confirm,
    // secondary action, the shared error line, and no header X while non-dismissible.
    await fireEvent.click(screen.getByRole('button', { name: 'Open replacement confirmation' }))
    const confirmation = await screen.findByRole('dialog', {
      name: 'Replace the running example?',
    })
    expect(within(confirmation).getByRole('alert')).toHaveTextContent(
      'A demo of the shared error line.',
    )
    expect(within(confirmation).queryByRole('button', { name: 'Close' })).toBeNull()
    await fireEvent.click(within(confirmation).getByRole('button', { name: 'Go back' }))
  })
})
