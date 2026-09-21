import type { StepState } from '@game-sandbox/schema'
import { describe, expect, it } from 'vitest'

import { SessionHealth } from '../src/lib/session-health.js'

/** A state whose agents spent the given hook times, and whose step took `stepMs` of wall clock. */
function state(
  agentMs: Record<string, number>,
  stepMs?: number,
  actedPlayers: ReadonlySet<string> = new Set(),
): StepState {
  const agents = Object.fromEntries(
    Object.entries(agentMs).map(([player, decision_ms]) => [
      player,
      {
        reward: 0,
        score: 0,
        timing: { decision_ms },
        ...(actedPlayers.has(player) ? { action: 0 } : {}),
      },
    ]),
  )
  const total = Object.values(agentMs).reduce((sum, ms) => sum + ms, 0)
  return {
    schema_version: 1,
    tick: 0,
    agents,
    timing: { started_at: 0, duration_ms: stepMs ?? total },
  } as StepState
}

/** Feed the same tick repeatedly so the smoothing settles; arrivals are exactly on time. */
function settle(health: SessionHealth, tick: StepState, targetMs: number, count = 12): number {
  let now = 0
  for (let i = 0; i < count; i += 1) {
    now += Math.max(tick.timing.duration_ms, targetMs)
    health.observe(tick, now, targetMs)
  }
  return now
}

describe('SessionHealth', () => {
  it('says nothing while a session keeps up with its cadence', () => {
    const health = new SessionHealth()
    const now = settle(health, state({ player_0: 40, player_1: 30 }), 250)
    expect(health.verdict(now, 250)).toBeNull()
  })

  it('names the villager that owns most of a slow tick', () => {
    // Three Branches paces at 250 ms; player_3 alone burns well past that.
    const health = new SessionHealth()
    const tick = state({ player_0: 30, player_1: 40, player_3: 2100 })
    const now = settle(health, tick, 250)
    expect(health.verdict(now, 250)).toEqual({ label: 'P3 2.1s', tone: 'warning' })
  })

  it('reports a first slow agent tick at its measured duration', () => {
    const health = new SessionHealth()
    health.observe(state({ player_3: 2100 }), 2100, 250)

    expect(health.verdict(2100, 250)).toEqual({ label: 'P3 2.1s', tone: 'warning' })
  })

  it("keeps each actor's smoothed time with that actor when turns alternate", () => {
    const health = new SessionHealth()
    const now = settle(health, state({ player_0: 4000 }), 250)
    const next = now + 250
    health.observe(state({ player_1: 10 }), next, 250)

    // P1 is the current actor, but its 10 ms hook cannot inherit P0's recent four-second work.
    expect(health.verdict(next, 250)).toEqual({ label: 'P0 2.8s', tone: 'warning' })
  })

  it('blames the cast as a whole when no single villager dominates', () => {
    const health = new SessionHealth()
    const tick = state({ player_0: 800, player_1: 800, player_2: 800, player_3: 800 })
    const now = settle(health, tick, 250)
    expect(health.verdict(now, 250)).toEqual({ label: 'Agents 3.2s', tone: 'warning' })
  })

  it('blames the server when the step outran the hooks charged inside it', () => {
    // The agents charged almost nothing; the step still took 1.4s. That is the environment transition,
    // or an agent blocking on a model call whose proxy time is discounted out of its own charge.
    const health = new SessionHealth()
    const now = settle(health, state({ player_0: 20, player_1: 20 }, 1400), 250)
    expect(health.verdict(now, 250)).toEqual({ label: 'Server 1.4s', tone: 'warning' })
  })

  it('blames delivery when frames lag far behind the work they describe', () => {
    // Each tick reports 40 ms of work but takes two seconds to arrive, so the carrier is at fault.
    const health = new SessionHealth()
    let now = 0
    for (let i = 0; i < 12; i += 1) {
      now += 2000
      health.observe(state({ player_0: 20, player_1: 20 }), now, 250)
    }
    expect(health.verdict(now, 250)).toEqual({ label: 'Link slow', tone: 'warning' })
  })

  it('does not mistake an honestly slow tick for a slow link', () => {
    // The gap is large, but the step itself accounts for it, so the agents are named instead.
    const health = new SessionHealth()
    const tick = state({ player_3: 3000 })
    const now = settle(health, tick, 250)
    expect(health.verdict(now, 250)).toEqual({ label: 'P3 3s', tone: 'warning' })
  })

  it('reports silence once nothing has arrived for a few seconds, whatever the last tick said', () => {
    const health = new SessionHealth()
    const now = settle(health, state({ player_3: 2100 }), 250)
    expect(health.verdict(now + 8000, 250)).toEqual({ label: 'No signal', tone: 'danger' })
  })

  it('clears prior cost samples on a completed human turn but retains its arrival baseline', () => {
    const health = new SessionHealth({ humanPlayers: new Set(['player_0']) })
    health.observe(state({ player_1: 40 }), 40, 0)
    health.observe(state({ player_0: 0 }, 5000, new Set(['player_0'])), 5040, 0)
    health.observe(state({ player_1: 40 }), 5080, 0)

    // The five-second human move is expected work, not a server or delivery fault.
    expect(health.verdict(5080, 0)).toBeNull()
  })

  it('suppresses unpaced human silence and transit diagnoses while retaining agent warnings', () => {
    const unpaced = new SessionHealth({ continuous: false })
    let now = 0
    for (let i = 0; i < 12; i += 1) {
      now += 2000
      unpaced.observe(state({ player_0: 40 }), now, 0)
    }

    expect(unpaced.verdict(now, 0)).toBeNull()
    expect(unpaced.verdict(now + 60_000, 0)).toBeNull()

    const slow = new SessionHealth({ continuous: false })
    expect(slow.verdict(settle(slow, state({ player_1: 2100 }), 0), 0)).toEqual({
      label: 'P1 2.1s',
      tone: 'warning',
    })
  })

  it('does not call a slow village silent during its own ordinary gap between ticks', () => {
    // Four seconds a tick means four seconds of quiet every tick. Judging that against a fixed
    // threshold would flash "No signal" over the true answer once per tick, which is the one thing
    // this badge must never do.
    const health = new SessionHealth()
    const now = settle(health, state({ player_3: 4000 }), 250)

    expect(health.verdict(now + 4000, 250)).toEqual({ label: 'P3 4s', tone: 'warning' })
    // Well past its own pace, though, the silence really is the story.
    expect(health.verdict(now + 20_000, 250)).toEqual({ label: 'No signal', tone: 'danger' })
  })

  it('stays quiet before the first frame, so a starting session is not accused of stalling', () => {
    const health = new SessionHealth()
    expect(health.verdict(60_000, 250)).toBeNull()
  })

  it('holds a turn-based environment to an absolute floor rather than a cadence it does not have', () => {
    const health = new SessionHealth()
    // 400 ms a turn is unremarkable without a cadence to beat.
    expect(health.verdict(settle(health, state({ player_0: 400 }), 0), 0)).toBeNull()
    const slow = new SessionHealth()
    expect(slow.verdict(settle(slow, state({ player_0: 2400 }), 0), 0)).toEqual({
      label: 'P0 2.4s',
      tone: 'warning',
    })
  })

  it('counts the optional chat and learn hooks as thinking time too', () => {
    const health = new SessionHealth()
    const tick = {
      schema_version: 1,
      tick: 0,
      agents: {
        player_0: {
          reward: 0,
          score: 0,
          timing: { decision_ms: 600, chat_ms: 500, learn_ms: 700 },
        },
      },
      timing: { started_at: 0, duration_ms: 1800 },
    } as StepState
    const now = settle(health, tick, 250)
    expect(health.verdict(now, 250)).toEqual({ label: 'P0 1.8s', tone: 'warning' })
  })

  it('rides out one slow tick among fast ones instead of flapping the badge', () => {
    const health = new SessionHealth()
    const fast = state({ player_0: 40 })
    const now = settle(health, fast, 250)
    health.observe(state({ player_0: 3000 }), now + 3000, 250)
    expect(health.verdict(now + 3000, 250)).toBeNull()
  })
})
