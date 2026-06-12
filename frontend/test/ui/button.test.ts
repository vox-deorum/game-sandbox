import { render, screen } from '@testing-library/vue'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

import UiButton from '../../src/components/ui/UiButton.vue'

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
}

describe('UiButton', () => {
  it('renders a button and forwards clicks', async () => {
    const onClick = vi.fn()
    render(UiButton, {
      slots: { default: 'Start' },
      attrs: { onClick },
    })
    const button = screen.getByRole('button', { name: 'Start' })
    button.click()
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('blocks clicks while disabled', () => {
    const onClick = vi.fn()
    render(UiButton, {
      props: { disabled: true },
      slots: { default: 'Start' },
      attrs: { onClick },
    })
    const button = screen.getByRole('button', { name: 'Start' })
    expect(button).toBeDisabled()
    button.click()
    expect(onClick).not.toHaveBeenCalled()
  })

  it('loading disables the button and marks it busy', () => {
    render(UiButton, { props: { loading: true }, slots: { default: 'Saving' } })
    const button = screen.getByRole('button', { name: 'Saving' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
  })

  it('renders a RouterLink when `to` is set', () => {
    render(UiButton, {
      props: { to: '/' },
      slots: { default: 'Home' },
      global: { plugins: [makeRouter()] },
    })
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
