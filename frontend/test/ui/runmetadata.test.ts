import { fireEvent, render, screen } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'

import RunMetadata from '../../src/components/RunMetadata.vue'

describe('RunMetadata LLM summary', () => {
  it('shows the authoritative whole-recording cost and full token details without latency or estimates', async () => {
    render(RunMetadata, {
      props: {
        items: [{ label: 'Seed', value: 4821 }],
        llmTelemetry: {
          total_budget_cost_units: 41_600,
          calls: [
            {
              tick: 12,
              slot: 'player_0',
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
    render(RunMetadata, { props: { items: [{ label: 'Seed', value: 4821 }] } })
    expect(screen.queryByText('LLM')).toBeNull()
    expect(screen.queryByRole('button', { name: /LLM cost/ })).toBeNull()
  })
})
