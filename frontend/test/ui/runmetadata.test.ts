import { fireEvent, render, screen } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'

import RunMetadata from '../../src/components/RunMetadata.vue'

describe('RunMetadata LLM summary', () => {
  it('shows the authoritative whole-recording cost and full token details without latency or estimates', async () => {
    render(RunMetadata, {
      props: {
        items: [{ label: 'Settings', value: '1 setting' }],
        llmTelemetry: {
          total_budget_cost_units: 41_600,
          calls: [
            {
              tick: 12,
              player: 'player_0',
              model: 'small',
              input_tokens: 100,
              reasoning_tokens: 20,
              output_tokens: 50,
              usage_estimated: true,
              cost_weight: 1.5,
              budget_cost_units: 225,
            },
          ],
        },
      },
    })

    const trigger = screen.getByRole('button', {
      name: 'Show whole-recording LLM cost details',
    })
    expect(trigger).toHaveTextContent('41.6k units')
    await fireEvent.focus(trigger)
    expect(screen.getByRole('tooltip')).toBeVisible()
    expect(screen.getByText(/1.5 units\/token/)).toHaveTextContent(
      '100 input + 50 output tokens, 20 reasoning tokens within output, 225 units',
    )
    expect(screen.queryByText(/latency/i)).toBeNull()
    expect(screen.queryByText(/estimate/i)).toBeNull()
  })

  it('omits the whole-recording total when telemetry is unavailable', () => {
    render(RunMetadata, { props: { items: [{ label: 'Settings', value: '1 setting' }] } })
    expect(screen.queryByText('LLM')).toBeNull()
    expect(screen.queryByRole('button', { name: /LLM cost/ })).toBeNull()
  })
})

describe('RunMetadata detail rows', () => {
  it('puts an item with details behind a tooltip on its summarizing value', async () => {
    render(RunMetadata, {
      props: {
        items: [
          {
            label: 'Settings',
            value: '2 settings',
            details: [
              { label: 'Pipe gap', value: '90' },
              { label: 'Seed', value: '4821' },
            ],
          },
        ],
      },
    })

    const trigger = screen.getByRole('button', { name: 'Show settings details' })
    expect(trigger).toHaveTextContent('2 settings')
    expect(screen.queryByRole('tooltip')).toBeNull()
    await fireEvent.focus(trigger)
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent('Pipe gap')
    expect(tooltip).toHaveTextContent('90')
    expect(tooltip).toHaveTextContent('Seed')
    expect(tooltip).toHaveTextContent('4821')
  })

  it('leaves an item without details as plain text', () => {
    render(RunMetadata, {
      props: { items: [{ label: 'Settings', value: 'None', details: [] }] },
    })
    expect(screen.getByText('None')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
