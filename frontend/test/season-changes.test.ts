import { render, screen } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'
import type { SeasonSettings } from '../src/api/client.js'
import SeasonChanges from '../src/components/SeasonChanges.vue'
import { flappyMeta } from './helpers/fixtures.js'

const changed: SeasonSettings = {
  season_id: 'week-4',
  season_label: 'Week 4',
  template_repo: { url: 'https://example.test/template', branch: 'week-4' },
  values: { players: 1, pipe_gap: 90 },
  rules: {
    step_timeout_ms: 500,
    episode_timeout_ms: 120_000,
    messaging_enabled: false,
    message_cap: null,
    llm_enabled: false,
  },
}

describe('SeasonChanges', () => {
  it('shows each changed setting as a default-to-season pair', () => {
    render(SeasonChanges, { props: { meta: flappyMeta(), settings: changed } })

    expect(screen.getByRole('list', { name: 'Season changes' })).toHaveTextContent(
      'Pipe gap 100 → 90',
    )
    expect(screen.getByRole('list', { name: 'Season changes' })).toHaveTextContent(
      'Decision limit 1 s → 0.5 s',
    )
  })

  it('states when every setting stays at the environment default', () => {
    render(SeasonChanges, {
      props: {
        meta: flappyMeta(),
        settings: {
          ...changed,
          values: { players: 1, pipe_gap: 100 },
          rules: { ...changed.rules, step_timeout_ms: 1000 },
        },
      },
    })

    expect(screen.getByText('This season uses the default settings.')).toBeInTheDocument()
  })
})
