import { describe, expect, it } from 'vitest'

import {
  type FailureAttribution,
  parseResultEnvelope,
  resolveFailureAttribution,
} from '../../src/workflow/workflow-runner.js'

const players = ['player_0', 'player_1']
const CLEAN_EXIT = { code: 0, oomKilled: false }
const CRASH_EXIT = { code: 1, oomKilled: false }

const envelope = (fields: Record<string, unknown>) =>
  parseResultEnvelope({ reason: 'terminated', scores: { player_0: 9, player_1: 4 }, ...fields })

/** The reason an all-failed attribution carries, or a clear failure when it was attributed instead. */
function allFailedReason(attribution: FailureAttribution): string {
  if (attribution.scope !== 'all-failed') {
    throw new Error(`expected an all-failed attribution, got ${attribution.scope}`)
  }
  return attribution.gameReason
}

describe('workflow fault attribution', () => {
  it('fails all seats for OOM and watchdog faults despite a stale named player', () => {
    const stale = () => envelope({ failed_player: 'player_0' })
    const oom = resolveFailureAttribution({ code: 137, oomKilled: true }, stale(), false, players)
    const watchdog = resolveFailureAttribution(
      { code: 137, oomKilled: false },
      stale(),
      true,
      players,
    )

    expect(allFailedReason(oom)).toMatch(/oom_killed/)
    expect(allFailedReason(watchdog)).toMatch(/watchdog/)
    expect(oom.status).toBe('failed')
    expect(watchdog.status).toBe('timed_out')
  })

  it('rejects a non-string failed_player while keeping absent and null values valid', () => {
    expect(envelope({}).failedPlayerMalformed).toBe(false)
    expect(envelope({ failed_player: null }).failedPlayerMalformed).toBe(false)
    expect(envelope({ failed_player: 0 }).failedPlayerMalformed).toBe(true)

    const attribution = resolveFailureAttribution(
      CRASH_EXIT,
      envelope({ failed_player: 0 }),
      false,
      players,
    )
    expect(allFailedReason(attribution)).toBe(
      'harness result failed_player must be a string or null',
    )
  })

  it('charges one player when the process outcome agrees a fault happened', () => {
    const attribution = resolveFailureAttribution(
      CRASH_EXIT,
      envelope({ failed_player: 'player_1' }),
      false,
      players,
    )

    expect(attribution.scope).toBe('attributed')
    expect(attribution.status).toBe('failed')
    if (attribution.scope !== 'attributed') return
    expect(attribution.culprit).toEqual({
      playerId: 'player_1',
      reason: 'agent container exited with code 1',
    })
    expect(attribution.scores).toEqual({ player_0: 9, player_1: 4 })
  })

  // A clean exit with a recognized ending describes no fault, so a `failed_player` alongside it is
  // stale and charges nobody. The gate lives here rather than in the caller, so a caller cannot read
  // a culprit the process outcome does not support.
  it('charges nobody when a clean, recognized ending still names a failed player', () => {
    const attribution = resolveFailureAttribution(
      CLEAN_EXIT,
      envelope({ failed_player: 'player_0' }),
      false,
      players,
    )

    expect(attribution.scope).toBe('attributed')
    expect(attribution.status).toBe('completed')
    expect(attribution.gameReason).toBeNull()
    if (attribution.scope !== 'attributed') return
    expect(attribution.culprit).toBeNull()
  })

  it('times out only the named player when the harness reports its episode budget', () => {
    const attribution = resolveFailureAttribution(
      CLEAN_EXIT,
      parseResultEnvelope({
        reason: 'episode_limit',
        scores: { player_0: 9, player_1: 4 },
        failed_player: 'player_0',
      }),
      false,
      players,
    )

    expect(attribution.status).toBe('timed_out')
    if (attribution.scope !== 'attributed') return
    expect(attribution.culprit?.playerId).toBe('player_0')
  })

  // Each case is a crash whose envelope named a culprit, so the "crash with nobody named" branch is
  // already past and these reach the envelope-validity checks they are meant to exercise.
  it.each([
    [
      'a score map that misses a resolved player',
      envelope({ scores: { player_0: 9 }, failed_player: 'player_0' }),
      /one finite score for every resolved player/,
    ],
    [
      'a score map naming a player outside the layout',
      envelope({ scores: { player_0: 9, player_1: 4, player_7: 1 }, failed_player: 'player_0' }),
      /one finite score for every resolved player/,
    ],
    [
      'a failed player outside the layout',
      envelope({ failed_player: 'player_7' }),
      /unknown failed player player_7/,
    ],
  ])('forfeits every seat for %s', (_label, result, message) => {
    const attribution = resolveFailureAttribution(CRASH_EXIT, result, false, players)
    expect(allFailedReason(attribution)).toMatch(message)
  })

  it('forfeits every seat when a clean exit produced no recognized reason', () => {
    const attribution = resolveFailureAttribution(CLEAN_EXIT, null, false, players)
    expect(allFailedReason(attribution)).toMatch(/without a valid result envelope/)
    expect(attribution.status).toBe('failed')
  })
})
