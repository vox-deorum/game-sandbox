// Smoke test: the styleguide page renders every primitive section without error. The page is the
// definition of done for primitive variants, so this suite fails when a section breaks at mount.
import { render, screen } from '@testing-library/vue'
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
      'UiStatusBadge',
      'UiCard',
      'UiField and UiInput',
      'UiSelect',
      'UiTabs',
      'UiDialog',
      'UiSlider',
      'UiEmptyState',
    ]) {
      expect(screen.getByRole('heading', { name: section })).toBeInTheDocument()
    }
  })
})
