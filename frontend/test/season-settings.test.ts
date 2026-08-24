import { describe, expect, it } from 'vitest'

import type { SeasonSettings } from '../src/api/client.js'
import {
  describeSeasonChanges,
  seasonSettingsFile,
  setupCommandsFor,
} from '../src/lib/season-settings.js'
import { flappyMeta, spadesMeta } from './helpers/fixtures.js'

const settings: SeasonSettings = {
  season_id: 'week-4',
  season_label: 'Week 4',
  template_repo: { url: 'https://example.test/template', branch: 'week-4' },
  values: { players: 1, pipe_gap: 90 },
  rules: {
    step_timeout_ms: 500,
    episode_timeout_ms: 60_000,
    messaging_enabled: false,
    message_cap: null,
    llm_enabled: false,
  },
}

describe('season settings', () => {
  it('describes only changed gameplay and reproducible limits', () => {
    expect(describeSeasonChanges(flappyMeta(), settings)).toEqual([
      { label: 'Pipe gap', from: '100', to: '90' },
      { label: 'Decision limit', from: '1 s', to: '0.5 s' },
      { label: 'Game limit', from: '120 s', to: '60 s' },
    ])
  })

  it('writes raw changed values into an optional local settings file', () => {
    expect(seasonSettingsFile(flappyMeta(), settings)).toEqual({
      env_id: 'flappy_bird',
      season: 'Week 4',
      parameters: { pipe_gap: 90 },
      decision_limit_ms: 500,
      game_limit_ms: 60_000,
    })
    expect(setupCommandsFor(flappyMeta(), settings)).toBe(
      'git clone -b week-4 --single-branch https://example.test/template flappy-bird-week-4\n' +
        'cd flappy-bird-week-4\ngit branch -M main\ngit remote remove origin',
    )
  })

  it('uses the season ID when the label is blank', () => {
    expect(seasonSettingsFile(flappyMeta(), { ...settings, season_label: ' \t ' })).toMatchObject({
      season: 'week-4',
    })
  })

  it('omits the file when all locally reproducible settings use defaults', () => {
    expect(
      seasonSettingsFile(flappyMeta(), {
        ...settings,
        values: { players: 1, pipe_gap: 100 },
        rules: { ...settings.rules, step_timeout_ms: 1000, episode_timeout_ms: 120_000 },
      }),
    ).toBeNull()
  })

  it('clones the default branch when the season names no branch', () => {
    expect(
      setupCommandsFor(flappyMeta(), {
        ...settings,
        template_repo: { ...settings.template_repo, branch: null },
      }),
    ).toBe(
      'git clone https://example.test/template flappy-bird-week-4\ncd flappy-bird-week-4\n' +
        'git branch -M main\ngit remote remove origin',
    )
  })

  it('keeps a changed message length visible when the season disables messaging', () => {
    const meta = spadesMeta()
    expect(
      describeSeasonChanges(meta, {
        ...settings,
        values: { seat_plan: 'partnership' },
        rules: {
          ...settings.rules,
          step_timeout_ms: meta.step_limit_ms,
          episode_timeout_ms: meta.episode_limit_ms,
          messaging_enabled: false,
          message_cap: 80,
        },
      }),
    ).toEqual([
      { label: 'Messaging', from: 'On', to: 'Off' },
      { label: 'Message length', from: '120', to: '80' },
    ])
  })

  it('formats every gameplay parameter type in declaration order', () => {
    const meta = flappyMeta({
      parameters: [
        {
          name: 'rounds',
          title: 'Rounds',
          description: 'Round count.',
          type: 'int',
          default: 1,
          min: 1,
          max: 5,
        },
        {
          name: 'speed',
          title: 'Speed',
          description: 'Movement speed.',
          type: 'float',
          default: 1.5,
          min: 0.5,
          max: 3,
        },
        {
          name: 'note',
          title: 'Note',
          description: 'A season note.',
          type: 'string',
          default: 'calm',
        },
        {
          name: 'fog',
          title: 'Fog',
          description: 'Whether fog is active.',
          type: 'bool',
          default: false,
        },
        {
          name: 'arena',
          title: 'Arena',
          description: 'The selected arena.',
          type: 'choice',
          default: 'small',
          choices: [
            { value: 'small', label: 'Small' },
            { value: 'large', label: 'Large' },
          ],
        },
        {
          name: 'items',
          title: 'Items',
          description: 'Enabled items.',
          type: 'multi_choice',
          default: ['shield'],
          choices: [
            { value: 'shield', label: 'Shield' },
            { value: 'boost', label: 'Boost' },
          ],
        },
      ],
    })
    expect(
      describeSeasonChanges(meta, {
        ...settings,
        values: {
          rounds: 2,
          speed: 2.25,
          note: 'fast',
          fog: true,
          arena: 'large',
          items: ['shield', 'boost'],
        },
        rules: {
          ...settings.rules,
          step_timeout_ms: meta.step_limit_ms,
          episode_timeout_ms: meta.episode_limit_ms,
        },
      }),
    ).toEqual([
      { label: 'Rounds', from: '1', to: '2' },
      { label: 'Speed', from: '1.5', to: '2.25' },
      { label: 'Note', from: 'calm', to: 'fast' },
      { label: 'Fog', from: 'Off', to: 'On' },
      { label: 'Arena', from: 'Small', to: 'Large' },
      { label: 'Items', from: 'Shield', to: 'Shield, Boost' },
    ])
  })

  it('keeps a changed choice whose values share a label visible', () => {
    const meta = flappyMeta({
      parameters: [
        {
          name: 'mode',
          title: 'Mode',
          description: 'The selected mode.',
          type: 'choice',
          default: 'first',
          choices: [
            { value: 'first', label: 'Shared' },
            { value: 'second', label: 'Shared' },
          ],
        },
      ],
    })
    expect(
      describeSeasonChanges(meta, {
        ...settings,
        values: { mode: 'second' },
        rules: {
          ...settings.rules,
          step_timeout_ms: meta.step_limit_ms,
          episode_timeout_ms: meta.episode_limit_ms,
        },
      }),
    ).toEqual([{ label: 'Mode', from: 'Shared', to: 'Shared' }])
  })

  it('shows opted-in LLM availability only for an environment with that capability', () => {
    const capable = flappyMeta({ llm: true })
    const season = {
      ...settings,
      values: { players: 1, pipe_gap: 100 },
      rules: {
        ...settings.rules,
        step_timeout_ms: capable.step_limit_ms,
        episode_timeout_ms: capable.episode_limit_ms,
      },
    }
    expect(describeSeasonChanges(capable, season)).toEqual([])
    expect(
      describeSeasonChanges(capable, {
        ...season,
        rules: { ...season.rules, llm_enabled: true },
      }),
    ).toEqual([{ label: 'LLM API', from: 'Off', to: 'On' }])
    expect(
      describeSeasonChanges(flappyMeta(), {
        ...season,
        rules: { ...season.rules, llm_enabled: true },
      }),
    ).toEqual([])
  })
})
