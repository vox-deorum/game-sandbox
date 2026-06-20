import { render, screen } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'

import DecisionLog from '../../src/components/DecisionLog.vue'

describe('DecisionLog', () => {
  it('renders a row per tick, formats the action and player, and marks the latest tick current', () => {
    render(DecisionLog, {
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
    // The slot is named in the Player column, humanized.
    expect(screen.getAllByText('Player 0')).toHaveLength(3)
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
})
