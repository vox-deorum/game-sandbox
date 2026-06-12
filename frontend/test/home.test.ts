import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { render, screen } from '@testing-library/vue'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

const META: EnvironmentMeta = {
  env_id: 'flappy_bird',
  display_name: 'Flappy Bird',
  description: 'A paced single-human clone.',
  min_slots: 1,
  max_slots: 1,
  human_slots: ['player_0'],
  human_timeout_ms: null,
  recommended_episode_ticks: 1000,
  pace_interval_ms: 50,
  step_limit_ms: 1000,
  episode_limit_ms: 120_000,
  messaging: false,
  message_cap: null,
  llm: false,
  renderer: 'flappy-bird',
}

vi.mock('../src/api/client.js', () => ({
  getEnvironments: vi.fn(async () => [META]),
}))

import HomePage from '../src/pages/home.vue'

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: HomePage },
      { path: '/environments/:envId', component: { template: '<div />' } },
    ],
  })
}

describe('HomePage', () => {
  it('renders a card per environment with the spec card fields', async () => {
    render(HomePage, { global: { plugins: [makeRouter()] } })
    expect(await screen.findByText('Flappy Bird')).toBeInTheDocument()
    expect(screen.getByText('A paced single-human clone.')).toBeInTheDocument()
    expect(screen.getByText('1 slot')).toBeInTheDocument()
    expect(screen.getByText('Human playable')).toBeInTheDocument()
    // The card links to the environment page.
    expect(screen.getByRole('link')).toHaveAttribute('href', '/environments/flappy_bird')
  })
})
