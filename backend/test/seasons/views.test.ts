import { describe, expect, it } from 'vitest'

import { runGameView, runView } from '../../src/seasons/views.js'
import type { SeasonRun, SeasonRunGame } from '../../src/storage/schema.js'

const game: SeasonRunGame = {
  id: 'game-1',
  run_id: 'run-1',
  match_index: 0,
  game_index: 0,
  seed: 1,
  seats: JSON.stringify([{ kind: 'builtin', name: 'naive' }]),
  seat_plan: 'solo',
  status: 'pending',
  recording_id: null,
  started_at: null,
  ended_at: null,
  error: null,
}

const run: SeasonRun = {
  id: 'run-1',
  season_id: 'season-1',
  requested_by: 'operator',
  config_snapshot: JSON.stringify({
    deps_version: 1,
    matches: [{ seats: ['submission'], seeds: [1], games: 1 }],
  }),
  parameters_snapshot: { players: 1, pipe_gap: 100 },
  llm_policy_snapshot: '{}',
  submission_snapshot: JSON.stringify([
    { kind: 'submission', submission_id: 'submission-1', user_id: 'user-1' },
  ]),
  status: 'pending',
  started_at: '2026-01-01T00:00:00.000Z',
  ended_at: null,
  error: null,
}

describe('season view agent-reference decoding', () => {
  it('decodes canonical references', () => {
    expect(runGameView(game).seats).toEqual([{ kind: 'builtin', name: 'naive' }])
    expect(runView(run, []).submission_snapshot).toEqual([
      { kind: 'submission', submission_id: 'submission-1', user_id: 'user-1' },
    ])
  })

  it('rejects malformed game and snapshot references', () => {
    expect(() => runGameView({ ...game, seats: JSON.stringify([{ kind: 'builtin' }]) })).toThrow(
      /valid agent references/,
    )
    expect(() =>
      runView(
        {
          ...run,
          submission_snapshot: JSON.stringify([{ kind: 'builtin', name: 'naive' }]),
        },
        [],
      ),
    ).toThrow(/only submissions/)
  })
})
