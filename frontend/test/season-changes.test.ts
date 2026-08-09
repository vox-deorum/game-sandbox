import { render, screen, within } from '@testing-library/vue'
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
  it('shows each changed setting as a default-to-season pair in an info box', () => {
    render(SeasonChanges, {
      props: {
        meta: flappyMeta(),
        settings: changed,
        context: 'season',
        season: { id: 'week-4', label: 'Week 4' },
      },
    })

    const changes = screen.getByRole('group', { name: 'Settings for season Week 4' })
    expect(changes).toHaveClass('ui-card', 'info')
    expect(within(changes).queryByText('Settings:')).toBeNull()
    expect(within(changes).getByText('Pipe gap')).toBeInTheDocument()
    expect(within(changes).getByText('100 → 90')).toBeInTheDocument()
    expect(within(changes).getByText('Decision limit')).toBeInTheDocument()
    expect(within(changes).getByText('1 s → 0.5 s')).toBeInTheDocument()
    expect(screen.getByText('Pipe gap from 100 to 90')).toBeInTheDocument()
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
        context: 'season',
        season: { id: 'week-4', label: 'Week 4' },
      },
    })

    const changes = screen.getByRole('group', { name: 'Settings for season Week 4' })
    expect(changes).toHaveClass('ui-card', 'info')
    expect(within(changes).getByText('This season uses the default settings.')).toBeInTheDocument()
  })

  it('names an unlabelled season by its short id in the group label', () => {
    render(SeasonChanges, {
      props: {
        meta: flappyMeta(),
        settings: changed,
        context: 'play season',
        season: { id: 'week-4', label: null },
      },
    })

    expect(
      screen.getByRole('group', { name: 'Settings for play season Season week-4' }),
    ).toBeInTheDocument()
  })
})
