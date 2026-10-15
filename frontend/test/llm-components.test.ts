import { fireEvent, render, screen, waitFor } from '@testing-library/vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import type { RecordingLlmCall } from '../src/api/client.js'
import LlmCostDetails from '../src/components/LlmCostDetails.vue'
import LlmCostTooltip from '../src/components/LlmCostTooltip.vue'
import RequestResponseView from '../src/components/RequestResponseView.vue'
import UiDialog from '../src/components/ui/UiDialog.vue'
import {
  decisionCallsKey,
  formatLlmCost,
  groupSetupCalls,
  indexDecisionCalls,
} from '../src/lib/llm.js'

const calls = [
  {
    model: 'small',
    input_tokens: 10,
    reasoning_tokens: 3,
    output_tokens: 8,
    cost_weight: 2,
    budget_cost_units: 36,
  },
  {
    model: 'small',
    input_tokens: 4,
    reasoning_tokens: 0,
    output_tokens: 2,
    cost_weight: 2,
    budget_cost_units: 12,
  },
]

afterEach(() => vi.useRealTimers())

describe('LLM shared presentation', () => {
  it('formats compact authoritative costs with an explicit units label', () => {
    expect(formatLlmCost(41600)).toBe('41.6k units')
    expect(formatLlmCost(1080)).toBe('1,080 units')
  })

  it('indexes tick calls by decision and groups setup calls by player', () => {
    const recorded = (tick: number | null, player: string, model: string) =>
      ({ ...calls[0], tick, player, model, usage_estimated: false }) as RecordingLlmCall
    const first = recorded(5, 'player_0', 'a')
    const second = recorded(5, 'player_0', 'b')
    const other = recorded(5, 'player_1', 'c')
    const setupB = recorded(null, 'player_1', 'd')
    const setupA = recorded(null, 'player_0', 'e')

    const index = indexDecisionCalls([first, setupB, other, second])
    expect(index.get(decisionCallsKey(5, 'player_0'))).toEqual([first, second])
    expect(index.get(decisionCallsKey(5, 'player_1'))).toEqual([other])
    // Setup calls serve no decision, so the index leaves them out.
    expect([...index.values()].flat()).not.toContain(setupB)

    expect(groupSetupCalls([setupB, setupA])).toEqual([
      { player: 'player_0', calls: [setupA] },
      { player: 'player_1', calls: [setupB] },
    ])
  })

  it('shows call counts, aliases, stored weights, charged token bases, and authoritative costs', () => {
    render(LlmCostDetails, {
      props: { calls, totalBudgetCostUnits: 48 },
    })
    expect(screen.getByText('2 successful calls')).toBeInTheDocument()
    expect(screen.getByText(/small: 2/)).toBeInTheDocument()
    expect(screen.getAllByText(/2 units\/token/)).toHaveLength(2)
    expect(screen.getByText(/10 input \+ 8 output tokens/)).toBeInTheDocument()
    expect(screen.getByText(/3 reasoning tokens within output/)).toBeInTheDocument()
    expect(screen.queryByText(/latency|estimate/i)).not.toBeInTheDocument()
  })

  it('associates the tooltip, keeps it open across hover, opens on focus, and closes on Escape', async () => {
    vi.useFakeTimers()
    render(LlmCostTooltip, {
      props: { calls, totalBudgetCostUnits: 48, accessibleLabel: 'Cost for player 1 tick 4' },
    })
    const trigger = screen.getByRole('button', { name: 'Cost for player 1 tick 4' })
    const describedBy = trigger.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()

    trigger.focus()
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveAttribute('id', describedBy)

    await fireEvent.mouseLeave(trigger.parentElement as HTMLElement)
    await vi.advanceTimersByTimeAsync(100)
    expect(screen.getByRole('tooltip')).toBeVisible()
    await fireEvent.mouseEnter(tooltip)
    await vi.advanceTimersByTimeAsync(150)
    expect(screen.getByRole('tooltip')).toBeVisible()

    await fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()

    await fireEvent.click(trigger)
    expect(screen.getByRole('tooltip')).toBeVisible()
    await fireEvent.pointerDown(trigger)
    await fireEvent.click(trigger)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('does not mount hidden tooltip content or block a containing dialog from closing', async () => {
    const Harness = defineComponent({
      components: { LlmCostTooltip, UiDialog },
      setup() {
        return { calls, open: ref(true) }
      },
      template:
        '<UiDialog v-model:open="open" title="Cost dialog"><LlmCostTooltip :calls="calls" :total-budget-cost-units="48" /></UiDialog>',
    })
    render(Harness)

    expect(await screen.findByRole('dialog', { name: 'Cost dialog' })).toBeInTheDocument()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Cost dialog' })).not.toBeInTheDocument(),
    )
  })

  it('shows Request and Response headings and copies each body', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(RequestResponseView, {
      props: { request: { prompt: 'hello' }, response: { answer: 'world' } },
    })

    expect(screen.getByRole('heading', { name: 'Request' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Response' })).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Copy request' }))
    expect(writeText).toHaveBeenCalledWith('{\n  "prompt": "hello"\n}')
    await fireEvent.click(screen.getByRole('button', { name: 'Copy response' }))
    expect(writeText).toHaveBeenLastCalledWith('{\n  "answer": "world"\n}')
  })

  it('reports clipboard rejection without leaving stale success feedback', async () => {
    const writeText = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('denied'))
    Object.assign(navigator, { clipboard: { writeText } })
    render(RequestResponseView, {
      props: { request: 'request body', response: 'response body' },
    })

    await fireEvent.click(screen.getByRole('button', { name: 'Copy request' }))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Copy response' }))
    expect(await screen.findByRole('button', { name: 'Copy failed' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument()
  })
})
