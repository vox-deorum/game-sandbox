import { describe, expect, it } from 'vitest'

import { failureText, isCompletedOutcome, reasonText, runFailure } from '../src/replay/reason.js'

describe('end reasons', () => {
  it('treats a crash as an incomplete run with its own label', () => {
    expect(reasonText('error')).toBe('Ended unexpectedly')
    expect(isCompletedOutcome('error')).toBe(false)
  })

  it('reads a failure only when there is a description to show', () => {
    expect(runFailure('player_3', null)).toBeNull()
    expect(runFailure('player_3', '')).toBeNull()
    expect(runFailure(undefined, 'RuntimeError: boom')).toEqual({
      failedPlayer: null,
      detail: 'RuntimeError: boom',
    })
  })

  it('charges the description to the player at fault, or to the game', () => {
    expect(failureText(runFailure('player_3', "KeyError: 'evening' (agent.py:88 in assign)"))).toBe(
      "P3's agent raised KeyError: 'evening' (agent.py:88 in assign)",
    )
    expect(failureText(runFailure(null, 'ValueError: bad layout'))).toBe(
      'The game raised ValueError: bad layout',
    )
    expect(failureText(null)).toBeNull()
  })
})
