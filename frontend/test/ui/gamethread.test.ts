import { fireEvent, render, screen } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'

import type { DecisionEntry } from '../../src/components/DecisionLog.vue'
import GameThread from '../../src/components/GameThread.vue'
import type { ChatEntry } from '../../src/lib/chat.js'

// A four-seat Spades roster: three agents sharing a label plus the viewer's human seat.
const PLAYERS = {
  player_0: { kind: 'agent' as const, label: 'Naive agent' },
  player_1: { kind: 'agent' as const, label: 'Naive agent' },
  player_2: { kind: 'human' as const, label: 'dev', user: 'dev' },
  player_3: { kind: 'agent' as const, label: 'Naive agent' },
}

function decisions(): DecisionEntry[] {
  return [
    { tick: 0, slot: 'player_0', action: 'bid 3' },
    { tick: 1, slot: 'player_1', action: 'bid 2' },
    { tick: 2, slot: 'player_2', action: 'play QS' },
    { tick: 3, slot: 'player_3', action: 'play KS' },
  ]
}

describe('GameThread', () => {
  it('exposes a labelled group so the page and e2e can target it', () => {
    render(GameThread, { props: { decisions: decisions(), chat: [] } })
    expect(screen.getByRole('group', { name: 'Game thread' })).toBeInTheDocument()
  })

  it('lists the whole game, dims ticks ahead of the scrubber, and highlights the current one', () => {
    const { container } = render(GameThread, {
      props: { decisions: decisions(), chat: [], currentIndex: 1, players: PLAYERS },
    })
    const rows = Array.from(container.querySelectorAll('.thread-item--decision'))
    // Every tick is listed, not just those up to the scrubber.
    expect(rows).toHaveLength(4)
    expect(screen.getByText('bid 3')).toBeInTheDocument()
    expect(screen.getByText('play KS')).toBeInTheDocument()

    // Index 1 is the current tick (marked, aria-current); 2 and 3 sit ahead (dimmed); 0 is past.
    const [past, current, futureA, futureB] = rows
    expect(current?.classList.contains('is-current')).toBe(true)
    expect(current?.getAttribute('aria-current')).toBe('true')
    expect(futureA?.classList.contains('is-future')).toBe(true)
    expect(futureB?.classList.contains('is-future')).toBe(true)
    expect(past?.classList.contains('is-current')).toBe(false)
    expect(past?.classList.contains('is-future')).toBe(false)
  })

  it("weaves each tick's messages in right after its decision, badged by seat", () => {
    const chat: ChatEntry[] = [
      { tick: 1, from: 'player_0', to: null, text: 'good luck' },
      { tick: 3, from: 'player_1', to: 'player_3', text: 'cover the king' },
    ]
    const { container } = render(GameThread, {
      props: { decisions: decisions(), chat, currentIndex: 3, players: PLAYERS },
    })

    expect(screen.getByText('good luck')).toBeInTheDocument()
    expect(screen.getByText('cover the king')).toBeInTheDocument()
    expect(screen.getByText('broadcast')).toBeInTheDocument()
    // A targeted line names its recipient by seat, so a same-labelled roster stays unambiguous.
    expect(screen.getByText('to Player 3')).toBeInTheDocument()

    // The broadcast rode tick 1, so it sits between the tick-1 and tick-2 decisions.
    const items = Array.from(container.querySelectorAll('.thread-item'))
    const message = items.findIndex((el) => el.textContent?.includes('good luck'))
    const tick1 = items.findIndex((el) => el.textContent?.includes('bid 2'))
    const tick2 = items.findIndex((el) => el.textContent?.includes('play QS'))
    expect(tick1).toBeLessThan(message)
    expect(message).toBeLessThan(tick2)
  })

  it('marks only the current decision with aria-current, not the messages riding its tick', () => {
    const chat: ChatEntry[] = [
      { tick: 3, from: 'player_1', to: 'player_3', text: 'cover the king' },
    ]
    const { container } = render(GameThread, {
      props: { decisions: decisions(), chat, currentIndex: 3, players: PLAYERS },
    })

    // Exactly one element is aria-current, and it is the current tick's decision row. Multiple
    // aria-current siblings are invalid and confuse assistive tech, so the message on the same tick
    // must not carry it even though it shares the tick's highlight.
    const current = Array.from(container.querySelectorAll('[aria-current="true"]'))
    expect(current).toHaveLength(1)
    expect(current[0]?.classList.contains('thread-item--decision')).toBe(true)

    const message = container.querySelector('.thread-item--message')
    expect(message?.classList.contains('is-current')).toBe(true)
    expect(message?.getAttribute('aria-current')).toBeNull()
  })

  it('shows an empty state when there are no decisions', () => {
    render(GameThread, { props: { decisions: [], chat: [] } })
    expect(screen.getByText('No decisions yet.')).toBeInTheDocument()
  })

  it('uses None for an empty decision slot', () => {
    const { container } = render(GameThread, {
      props: {
        decisions: [{ tick: 0, slot: '', action: 'wait' }],
        chat: [],
      },
    })

    expect(container.querySelector('.thread-seat')).toHaveTextContent('None')
  })

  it('keeps setup costs, exact decision costs, and authorized inspection in chat replays', async () => {
    const { container } = render(GameThread, {
      props: {
        decisions: decisions().slice(0, 2),
        chat: [{ tick: 0, from: 'player_0', to: null, text: 'thinking' }],
        setupLlmCalls: [
          {
            tick: null,
            slot: 'player_1',
            model: 'small',
            input_tokens: 2,
            reasoning_tokens: 0,
            output_tokens: 1,
            usage_estimated: false,
            cost_weight: 1,
            budget_cost_units: 3,
          },
        ],
        llmCalls: [
          {
            tick: 0,
            slot: 'player_0',
            model: 'medium',
            input_tokens: 3,
            reasoning_tokens: 1,
            output_tokens: 2,
            usage_estimated: false,
            cost_weight: 2,
            budget_cost_units: 10,
            request: { prompt: 'move' },
            completion: { answer: 'bid 3' },
          },
        ],
      },
    })

    expect(container.querySelector('[data-row-id="setup:player_1"]')).toHaveTextContent('3 units')
    expect(screen.getByText('thinking')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Inspect request and response' })).toHaveTextContent(
      '10 units',
    )
    expect(screen.getByText('None')).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Inspect request and response' }))
    expect(screen.getByRole('heading', { name: 'Request' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Response' })).toBeInTheDocument()
  })
})
