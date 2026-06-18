import { render, screen } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

import AppNav from '../src/components/AppNav.vue'

describe('AppNav', () => {
  it('links Leaderboards to the current environment while Agents remains a placeholder', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: { template: '<div />' } },
        { path: '/environments/:envId', component: { template: '<div />' } },
        {
          path: '/environments/:envId/leaderboards/:iterationId?',
          component: { template: '<div />' },
        },
      ],
    })
    router.push('/environments/flappy_bird')
    await router.isReady()

    render(AppNav, { global: { plugins: [router] } })

    expect(screen.getByRole('link', { name: 'Leaderboards' })).toHaveAttribute(
      'href',
      '/environments/flappy_bird/leaderboards',
    )
    expect(screen.getByText('Agents').closest('span')).toHaveTextContent('soon')
  })
})
