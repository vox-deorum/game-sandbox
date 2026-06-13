import { render, screen } from '@testing-library/vue'
import { describe, expect, it, vi } from 'vitest'

import { flappyMeta } from './helpers/fixtures.js'
import { memoryRouter } from './helpers/render.js'

const META = flappyMeta()

vi.mock('../src/api/client.js', () => ({
  getEnvironments: vi.fn(async () => [META]),
}))

import HomePage from '../src/pages/HomePage.vue'

function makeRouter() {
  return memoryRouter([
    { path: '/', component: HomePage },
    { path: '/environments/:envId', component: { template: '<div />' } },
  ])
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
