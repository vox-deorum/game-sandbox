import { fireEvent, render, screen, waitFor, within } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'

import type { RecordingLlmCall } from '../../src/api/client.js'
import DecisionLog from '../../src/components/DecisionLog.vue'

function call(overrides: Partial<RecordingLlmCall> = {}): RecordingLlmCall {
  return {
    tick: 5,
    slot: 'player_0',
    model: 'small',
    input_tokens: 2,
    reasoning_tokens: 1,
    output_tokens: 2,
    usage_estimated: false,
    cost_weight: 1.5,
    budget_cost_units: 6,
    ...overrides,
  }
}

describe('DecisionLog', () => {
  it('renders a row per tick, formats the action and player, and marks the latest tick current', () => {
    const { container } = render(DecisionLog, {
      props: {
        entries: [
          { tick: 5, slot: 'player_0', action: 0 },
          { tick: 6, slot: 'player_0', action: 1 },
          { tick: 7, slot: 'player_0', action: { flap: true } },
        ],
      },
    })
    // One header row plus a row per tick.
    expect(screen.getAllByRole('row')).toHaveLength(4)
    // The Player column shows the formatted slot label.
    const playerCells = container.querySelectorAll('tbody td.player-col')
    expect([...playerCells].map((c) => c.textContent)).toEqual(['P0', 'P0', 'P0'])
    // A structured action is formatted generically as key=value.
    expect(screen.getByText('flap=true')).toBeInTheDocument()
    // The live log pins to the latest tick: that row is the current one.
    const current = screen
      .getAllByRole('row')
      .find((r) => r.getAttribute('aria-current') === 'true')
    expect(current).toBeDefined()
    expect(current).toHaveTextContent('7')
  })

  it('marks the scrubbed index current when one is given (replay)', () => {
    render(DecisionLog, {
      props: {
        entries: [
          { tick: 5, slot: 'player_0', action: 0 },
          { tick: 6, slot: 'player_0', action: 1 },
          { tick: 7, slot: 'player_0', action: 0 },
        ],
        currentIndex: 1,
      },
    })
    const current = screen
      .getAllByRole('row')
      .find((r) => r.getAttribute('aria-current') === 'true')
    expect(current).toHaveTextContent('6')
  })

  it('shows an empty state when there are no decisions', () => {
    render(DecisionLog, { props: { entries: [] } })
    expect(screen.getByText('No decisions yet.')).toBeInTheDocument()
  })

  it('groups exact tick and slot matches and sums multiple successful calls', async () => {
    render(DecisionLog, {
      props: {
        entries: [
          { tick: 5, slot: 'player_0', action: 0 },
          { tick: 5, slot: 'player_1', action: 1 },
          { tick: 6, slot: 'player_0', action: 0 },
        ],
        llmCalls: [
          call(),
          call({ model: 'medium', budget_cost_units: 20, cost_weight: 2 }),
          call({ slot: 'player_1', budget_cost_units: 4 }),
          call({ tick: 6, slot: 'player_1', budget_cost_units: 100 }),
        ],
      },
    })

    const rows = screen.getAllByRole('row').slice(1)
    const firstCost = within(rows[0] as HTMLElement).getByRole('button', {
      name: 'LLM cost details',
    })
    expect(firstCost).toHaveTextContent('26 units')
    expect(
      within(rows[1] as HTMLElement).getByRole('button', { name: 'LLM cost details' }),
    ).toHaveTextContent('4 units')
    expect(within(rows[2] as HTMLElement).getByText('None')).toBeInTheDocument()
    firstCost.focus()
    await screen.findByRole('tooltip')
    const firstDetails = document.getElementById(firstCost.getAttribute('aria-describedby') ?? '')
    expect(firstDetails).not.toBeNull()
    expect(within(firstDetails as HTMLElement).getByText('2 successful calls')).toBeInTheDocument()
    expect(within(firstDetails as HTMLElement).getByText(/small: 1/)).toBeInTheDocument()
    expect(within(firstDetails as HTMLElement).getByText(/medium: 1/)).toBeInTheDocument()
  })

  it('renders setup calls from a separate prop in slot order without shifting the active decision', () => {
    const { container } = render(DecisionLog, {
      props: {
        entries: [
          { tick: 5, slot: 'player_0', action: 0 },
          { tick: 6, slot: 'player_0', action: 1 },
        ],
        currentIndex: 1,
        setupLlmCalls: [
          call({ tick: null, slot: 'player_1', budget_cost_units: 8 }),
          call({ tick: null, slot: 'player_0', budget_cost_units: 3 }),
          call({ tick: null, slot: 'player_0', budget_cost_units: 4 }),
        ],
      },
    })

    const setupRows = [...container.querySelectorAll('tr[data-row-id]')]
    expect(setupRows.map((row) => row.getAttribute('data-row-id'))).toEqual([
      'setup:player_0',
      'setup:player_1',
    ])
    expect(setupRows[0]).toHaveTextContent('7 units')
    expect(setupRows.every((row) => !row.hasAttribute('aria-current'))).toBe(true)
    const current = container.querySelector('tr[aria-current="true"]')
    expect(current).toHaveTextContent('6')
    expect(current?.querySelectorAll('td')[2]).toHaveTextContent('1')
  })

  it('scrolls to the scrubbed decision rather than a leading setup row', async () => {
    const view = render(DecisionLog, {
      props: {
        entries: [
          { tick: 5, slot: 'player_0', action: 0 },
          { tick: 6, slot: 'player_0', action: 1 },
        ],
        currentIndex: 1,
        setupLlmCalls: [],
      },
    })
    const scroller = view.container.querySelector('.decision-log') as HTMLElement
    const decisions = view.container.querySelectorAll('tbody:last-of-type tr')
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(decisions[1], 'offsetTop', { configurable: true, value: 240 })

    await view.rerender({
      entries: [
        { tick: 5, slot: 'player_0', action: 0 },
        { tick: 6, slot: 'player_0', action: 1 },
      ],
      currentIndex: 1,
      setupLlmCalls: [
        call({ tick: null, slot: 'player_0' }),
        call({ tick: null, slot: 'player_1' }),
      ],
    })

    await waitFor(() => expect(scroller.scrollTop).toBe(190))
  })

  it('shows Unavailable on decisions and invents no setup rows when telemetry is unavailable', () => {
    const { container } = render(DecisionLog, {
      props: {
        entries: [
          { tick: 5, slot: 'player_0', action: 0 },
          { tick: 6, slot: 'player_0', action: 1 },
        ],
        setupLlmCalls: [call({ tick: null })],
        llmUnavailable: true,
      },
    })

    expect(screen.getAllByText('Unavailable')).toHaveLength(2)
    expect(container.querySelector('[data-row-id^="setup:"]')).toBeNull()
    expect(screen.queryByText('None')).toBeNull()
  })

  it('shows Loading on decisions and invents no setup rows while telemetry is pending', () => {
    const { container } = render(DecisionLog, {
      props: {
        entries: [{ tick: 5, slot: 'player_0', action: 0 }],
        setupLlmCalls: [call({ tick: null })],
        llmPending: true,
      },
    })

    expect(screen.getByText('Loading')).toBeInTheDocument()
    expect(container.querySelector('[data-row-id^="setup:"]')).toBeNull()
    expect(screen.queryByText('None')).toBeNull()
  })

  it('omits replay-only LLM cost data when live callers supply no telemetry', () => {
    render(DecisionLog, {
      props: { entries: [{ tick: 5, slot: 'player_0', action: 0 }] },
    })

    expect(screen.queryByRole('columnheader', { name: 'LLM cost' })).toBeNull()
    expect(screen.queryByText('None')).toBeNull()
  })

  it('opens the exact request and response inspector only when bodies are returned', async () => {
    const authorized = call({
      request: { model: 'small', messages: ['move?'] },
      completion: { choices: ['left'] },
    })
    const view = render(DecisionLog, {
      props: {
        entries: [{ tick: 5, slot: 'player_0', action: 0 }],
        llmCalls: [authorized],
      },
    })

    const trigger = screen.getByRole('button', { name: 'Inspect request and response' })
    trigger.focus()
    await fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Inspect request and response' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Request' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Response' })).toBeInTheDocument()
    expect(screen.getByText(/move\?/)).toBeInTheDocument()
    expect(screen.getByText(/left/)).toBeInTheDocument()

    await fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(trigger).toHaveFocus())
    await fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(screen.getByRole('dialog', { name: 'Inspect request and response' })).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(trigger).toHaveFocus())
    await fireEvent.keyDown(trigger, { key: ' ' })
    expect(screen.getByRole('dialog', { name: 'Inspect request and response' })).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await view.rerender({
      entries: [{ tick: 5, slot: 'player_0', action: 0 }],
      llmCalls: [call()],
    })
    expect(screen.queryByRole('button', { name: 'Inspect request and response' })).toBeNull()
    expect(screen.getByRole('button', { name: /LLM cost details/ })).toBeInTheDocument()
  })
})
