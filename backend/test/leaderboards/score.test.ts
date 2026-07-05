/**
 * The per-environment leaderboard-score seams: {@link normalizeEpisodeScore} maps a clean game's raw
 * score to the higher-is-better board score, and {@link forfeitScore} is the floor a failed/incomplete
 * game contributes instead of its partial score, so a forfeit can never out-rank honest play.
 */
import { describe, expect, it } from 'vitest'

import { forfeitScore, normalizeEpisodeScore } from '../../src/leaderboards/score.js'

describe('normalizeEpisodeScore', () => {
  it('is the identity for the higher-is-better environments of this stage', () => {
    expect(normalizeEpisodeScore('flappy_bird', 12)).toBe(12)
    expect(normalizeEpisodeScore('flappy_bird', 0)).toBe(0)
  })
})

describe('forfeitScore', () => {
  it('floors a forfeited Hearts hand at its worst possible leaderboard score', () => {
    // A single Hearts hand is worth at most 26 penalty points; the leaderboard score negates that.
    expect(forfeitScore('hearts')).toBe(-26)
  })

  it('keeps a forfeit below every honest Hearts outcome, closing the crash-to-the-top exploit', () => {
    // Honest play always yields a leaderboard score in [-26, 0]; an aborted hand has a partial ~0 that
    // would be the *best* score. The floor must sit at or below the worst honest hand so failing loses.
    const worstHonestHand = -26
    const typicalHonestHand = -13
    const abortedPartial = 0 // what an early crash banks before any penalty accrues
    expect(forfeitScore('hearts')).toBeLessThanOrEqual(worstHonestHand)
    expect(forfeitScore('hearts')).toBeLessThan(typicalHonestHand)
    expect(forfeitScore('hearts')).toBeLessThan(abortedPartial)
  })

  it('floors a forfeited Spades hand at its worst possible team score', () => {
    // A partnership's worst single-hand team score is -260 (both partners bid 13, an unmakeable
    // 26-trick contract set for -10 * 26). A seat is ranked by its team score, so that is the floor.
    expect(forfeitScore('spades')).toBe(-260)
  })

  it('keeps a Spades forfeit below every honest team outcome', () => {
    const worstHonestHand = -260 // both partners bid 13 and take nothing
    const typicalBadHand = -30 // a modest set contract
    const abortedPartial = 0 // what an early crash banks before scoring
    expect(forfeitScore('spades')).toBeLessThanOrEqual(worstHonestHand)
    expect(forfeitScore('spades')).toBeLessThan(typicalBadHand)
    expect(forfeitScore('spades')).toBeLessThan(abortedPartial)
  })

  it('floors an upward-accruing environment at zero, where a failure already sits near the bottom', () => {
    // Flappy Bird's score climbs from zero as pipes are passed, so an early failure is already low;
    // zero (no progress) is the natural forfeit floor and the default for unregistered environments.
    expect(forfeitScore('flappy_bird')).toBe(0)
    expect(forfeitScore('some_future_env')).toBe(0)
  })
})
