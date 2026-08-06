import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  type EnvironmentMeta,
  type EnvParameter,
  isEnvironmentMeta,
  isEnvParameter,
  resolveLayout,
  resolveParameters,
  validateCompleteParameters,
  validateParameterValue,
} from '../src/index.js'

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'parameter-values.json',
)
const LAYOUT_FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'layout-values.json',
)

type ParameterFixtures = {
  declarations: EnvParameter[]
  validation_cases: Array<{
    name: string
    value: unknown
    valid: boolean
    normalized?: unknown
  }>
  resolution_cases: Array<{
    layers: Array<Record<string, unknown>>
    values: Record<string, unknown>
  }>
  rejection_cases: Array<{ layer: Record<string, unknown>; name: string }>
}

const PARAMETER_FIXTURES = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as ParameterFixtures

type LayoutFixtures = {
  valid: Array<{
    name: string
    meta: Pick<EnvironmentMeta, 'layout' | 'human_players'>
    parameters: Record<string, string | number>
    layout: {
      plan_key: string
      seats: Array<{ seat_id: string; players: string[]; restricted_builtin: string | null }>
      player_count: number
      seat_count: number
    }
  }>
  invalid: Array<{ name: string; layout: unknown }>
}

const LAYOUT_FIXTURES = JSON.parse(readFileSync(LAYOUT_FIXTURE_PATH, 'utf-8')) as LayoutFixtures

/** The shared declarations keyed by name, for the suites that look one up. */
const declarations = new Map(
  PARAMETER_FIXTURES.declarations.map((declaration) => [declaration.name, declaration]),
)

const VALID: EnvironmentMeta = {
  env_id: 'flappy_bird',
  display_name: 'Flappy Bird',
  description: 'A paced single-human clone.',
  builtin_agents: [{ name: 'naive', label: 'Naive agent' }],
  layout: { kind: 'player_bounds', min: 1, max: 4 },
  human_players: ['player_0'],
  human_timeout_ms: null,
  recommended_episode_ticks: 1000,
  pace_interval_ms: 50,
  stepping: 'sequential',
  step_limit_ms: 1000,
  episode_limit_ms: 120_000,
  messaging: false,
  message_cap: null,
  llm: false,
  renderer: 'flappy-bird',
  seat_order_matters: false,
  view_interval_ms: null,
  live_interval_ms: null,
  parameters: PARAMETER_FIXTURES.declarations,
  presets: [
    {
      name: 'gentle_start',
      title: 'Gentle start',
      values: { pipe_gap: 140, enabled: false, powerups: ['shield'] },
    },
  ],
}

describe('isEnvironmentMeta', () => {
  it('accepts a field-complete entry', () => {
    expect(isEnvironmentMeta(VALID)).toBe(true)
  })

  it('accepts metadata without optional named parameter presets', () => {
    const { presets: _presets, ...withoutPresets } = VALID
    expect(isEnvironmentMeta(withoutPresets)).toBe(true)
  })

  it('accepts the int-or-null fields as either', () => {
    expect(
      isEnvironmentMeta({
        ...VALID,
        pace_interval_ms: null,
        human_timeout_ms: 5000,
        view_interval_ms: 2000,
        live_interval_ms: 900,
      }),
    ).toBe(true)
  })

  it('accepts simultaneous metadata with a positive input window and no human timeout', () => {
    expect(isEnvironmentMeta({ ...VALID, stepping: 'simultaneous', pace_interval_ms: 50 })).toBe(
      true,
    )
  })

  it('requires an explicit known stepping mode', () => {
    const { stepping: _omitted, ...withoutStepping } = VALID
    expect(isEnvironmentMeta(withoutStepping)).toBe(false)
    expect(isEnvironmentMeta({ ...VALID, stepping: 'turn_based' })).toBe(false)
  })

  it('rejects simultaneous metadata without a positive pace interval or with a human timeout', () => {
    expect(isEnvironmentMeta({ ...VALID, stepping: 'simultaneous', pace_interval_ms: null })).toBe(
      false,
    )
    expect(isEnvironmentMeta({ ...VALID, stepping: 'simultaneous', pace_interval_ms: 0 })).toBe(
      false,
    )
    expect(isEnvironmentMeta({ ...VALID, stepping: 'simultaneous', pace_interval_ms: -1 })).toBe(
      false,
    )
    expect(isEnvironmentMeta({ ...VALID, stepping: 'simultaneous', human_timeout_ms: 5000 })).toBe(
      false,
    )
  })

  it('rejects a non-numeric view_interval_ms', () => {
    expect(isEnvironmentMeta({ ...VALID, view_interval_ms: '2000' })).toBe(false)
  })

  it('rejects a non-numeric live_interval_ms', () => {
    expect(isEnvironmentMeta({ ...VALID, live_interval_ms: '900' })).toBe(false)
  })

  it('rejects a fractional pace interval in any stepping mode', () => {
    expect(isEnvironmentMeta({ ...VALID, pace_interval_ms: 16.5 })).toBe(false)
  })

  it('rejects a non-object', () => {
    expect(isEnvironmentMeta(null)).toBe(false)
    expect(isEnvironmentMeta('flappy_bird')).toBe(false)
  })

  it('rejects an entry missing a field', () => {
    const { renderer: _omitted, ...withoutRenderer } = VALID
    expect(isEnvironmentMeta(withoutRenderer)).toBe(false)
  })

  it('rejects an entry whose human_players is not a string array', () => {
    expect(isEnvironmentMeta({ ...VALID, human_players: [0, 1] })).toBe(false)
  })

  it('rejects an entry without parameter declarations', () => {
    const { parameters: _omitted, ...withoutParameters } = VALID
    expect(isEnvironmentMeta(withoutParameters)).toBe(false)
  })

  it('requires unique named builtins with naive first and non-empty labels', () => {
    expect(isEnvironmentMeta({ ...VALID, builtin_agents: [] })).toBe(false)
    expect(
      isEnvironmentMeta({ ...VALID, builtin_agents: [{ name: 'cautious', label: 'Cautious' }] }),
    ).toBe(false)
    expect(
      isEnvironmentMeta({
        ...VALID,
        builtin_agents: [
          { name: 'naive', label: 'Naive' },
          { name: 'naive', label: 'Again' },
        ],
      }),
    ).toBe(false)
    expect(isEnvironmentMeta({ ...VALID, builtin_agents: [{ name: 'naive', label: '' }] })).toBe(
      false,
    )
    expect(
      isEnvironmentMeta({ ...VALID, builtin_agents: [{ name: 'Not snake', label: 'Naive' }] }),
    ).toBe(false)
  })

  it('rejects metadata without the synthesized players declaration', () => {
    expect(isEnvironmentMeta({ ...VALID, parameters: VALID.parameters.slice(1) })).toBe(false)
  })

  it('rejects both reserved names in ordinary parameters', () => {
    const ordinary = VALID.parameters.slice(1)
    const stringParameter = {
      title: 'Layout',
      description: 'No.',
      type: 'string' as const,
      default: 'x',
    }
    expect(
      isEnvironmentMeta({
        ...VALID,
        parameters: [VALID.parameters[0], ...ordinary, { name: 'players', ...stringParameter }],
      }),
    ).toBe(false)
    expect(
      isEnvironmentMeta({
        ...VALID,
        parameters: [VALID.parameters[0], ...ordinary, { name: 'seat_plan', ...stringParameter }],
      }),
    ).toBe(false)
  })

  it('rejects a synthesized players declaration that disagrees with the layout bounds', () => {
    expect(isEnvironmentMeta({ ...VALID, layout: { kind: 'player_bounds', min: 1, max: 3 } })).toBe(
      false,
    )
  })

  it('rejects unknown and mixed layout variants', () => {
    expect(isEnvironmentMeta({ ...VALID, layout: { kind: 'unknown' } })).toBe(false)
    expect(
      isEnvironmentMeta({
        ...VALID,
        layout: { kind: 'player_bounds', min: 1, max: 4, plans: [] },
      }),
    ).toBe(false)
  })

  it('rejects malformed parameter declarations', () => {
    expect(
      isEnvironmentMeta({
        ...VALID,
        parameters: [{ ...PARAMETER_FIXTURES.declarations[0], min: 4, max: 1 }],
      }),
    ).toBe(false)
  })

  it('rejects malformed presets and non-record values', () => {
    expect(
      isEnvironmentMeta({
        ...VALID,
        presets: [{ name: 'Gentle start', title: 'Gentle start', values: {} }],
      }),
    ).toBe(false)
    expect(
      isEnvironmentMeta({
        ...VALID,
        presets: [{ name: 'gentle_start', title: '', values: {} }],
      }),
    ).toBe(false)
    expect(
      isEnvironmentMeta({
        ...VALID,
        presets: [{ name: 'gentle_start', title: 'Gentle start', values: null }],
      }),
    ).toBe(false)
  })
})

describe('environment parameter declarations', () => {
  it('accepts all shared declarations', () => {
    expect(PARAMETER_FIXTURES.declarations.every(isEnvParameter)).toBe(true)
  })

  it('rejects non-finite numeric declaration bounds and duplicate choices', () => {
    const intDeclaration = PARAMETER_FIXTURES.declarations[0]
    const choicesDeclaration = PARAMETER_FIXTURES.declarations.find(
      (declaration) => declaration.type === 'choice',
    )
    expect(isEnvParameter({ ...intDeclaration, min: Number.NEGATIVE_INFINITY })).toBe(false)
    expect(
      isEnvParameter({
        ...choicesDeclaration,
        choices: [
          { value: 'same', label: 'One' },
          { value: 'same', label: 'Two' },
        ],
      }),
    ).toBe(false)
  })
})

describe('validateParameterValue', () => {
  function declarationFor(name: string): EnvParameter {
    const declaration = declarations.get(name)
    if (declaration === undefined) {
      throw new Error(`Missing shared declaration: ${name}`)
    }
    return declaration
  }

  it('matches the shared accepted, rejected, and normalized value cases', () => {
    for (const testCase of PARAMETER_FIXTURES.validation_cases) {
      const result = validateParameterValue(declarationFor(testCase.name), testCase.value)
      if (testCase.valid) {
        expect(result, testCase.name).toEqual({ value: testCase.normalized })
      } else {
        expect(result.issue, testCase.name).toBeDefined()
      }
    }
  })

  it('rejects non-finite float values that JSON fixtures cannot express', () => {
    const declaration = declarationFor('gravity')
    expect(validateParameterValue(declaration, Number.NaN).issue).toBeDefined()
    expect(validateParameterValue(declaration, Number.POSITIVE_INFINITY).issue).toBeDefined()
    expect(validateParameterValue(declaration, Number.NEGATIVE_INFINITY).issue).toBeDefined()
  })
})

describe('resolveParameters', () => {
  it('matches the shared layered-resolution cases', () => {
    for (const testCase of PARAMETER_FIXTURES.resolution_cases) {
      const result = resolveParameters(PARAMETER_FIXTURES.declarations, ...testCase.layers)
      expect(result.values).toEqual(testCase.values)
      expect(result.issues).toEqual([])
    }
  })

  // The Python resolver raises on the same entries this one reports as issues, so the shared file
  // names the rejected entry and each side asserts rejection in its own terms. Here that also means
  // the rejected entry keeps its default, which is what lets a public read serve usable values when a
  // stored season override has drifted from the declarations.
  it('reports each shared rejection case and keeps that parameter at its default', () => {
    for (const testCase of PARAMETER_FIXTURES.rejection_cases) {
      const result = resolveParameters(PARAMETER_FIXTURES.declarations, testCase.layer)
      expect(
        result.issues.map((issue) => issue.name),
        testCase.name,
      ).toEqual([testCase.name])
      const declaration = declarations.get(testCase.name)
      if (declaration !== undefined) {
        expect(result.values[testCase.name], testCase.name).toEqual(declaration.default)
      }
    }
  })
})

describe('validateCompleteParameters', () => {
  const COMPLETE_PARAMETERS = {
    players: 2,
    pipe_gap: 120,
    gravity: 0.75,
    label: '',
    enabled: true,
    mode: 'hard',
    powerups: ['magnet', 'shield'],
  }

  it('normalizes every declared value in a complete map', () => {
    const result = validateCompleteParameters(PARAMETER_FIXTURES.declarations, COMPLETE_PARAMETERS)

    expect(result).toEqual({
      values: {
        players: 2,
        pipe_gap: 120,
        gravity: 0.75,
        label: '',
        enabled: true,
        mode: 'hard',
        powerups: ['shield', 'magnet'],
      },
      issues: [],
    })
  })

  it('reports missing and unknown values without applying defaults', () => {
    const unknown = validateCompleteParameters(PARAMETER_FIXTURES.declarations, {
      ...COMPLETE_PARAMETERS,
      extra: 'no',
    })
    expect(unknown.values).not.toHaveProperty('extra')
    expect(unknown.issues).toEqual([{ name: 'extra', message: 'is not a declared parameter' }])

    const { powerups: _missing, ...withoutPowerups } = COMPLETE_PARAMETERS
    const missing = validateCompleteParameters(PARAMETER_FIXTURES.declarations, withoutPowerups)
    expect(missing.values).not.toHaveProperty('powerups')
    expect(missing.issues).toEqual([{ name: 'powerups', message: 'is required' }])
  })
})

describe('resolveLayout', () => {
  it('builds the canonical singleton solo layout', () => {
    expect(resolveLayout(VALID, { players: 3 })).toEqual({
      planKey: 'solo',
      seats: [
        { seatId: 'seat_0', players: ['player_0'], restrictedBuiltin: null },
        { seatId: 'seat_1', players: ['player_1'], restrictedBuiltin: null },
        { seatId: 'seat_2', players: ['player_2'], restrictedBuiltin: null },
      ],
      playerCount: 3,
      seatCount: 3,
    })
  })

  it('matches every valid shared layout fixture', () => {
    for (const testCase of LAYOUT_FIXTURES.valid) {
      const layout = testCase.meta.layout
      const parameter =
        layout.kind === 'player_bounds'
          ? {
              name: 'players',
              title: 'Players',
              description: 'Number of PettingZoo players in each game.',
              type: 'int' as const,
              default: layout.max,
              min: layout.min,
              max: layout.max,
            }
          : {
              name: 'seat_plan',
              title: 'Seat plan',
              description: 'Seat-to-player layout for each game.',
              type: 'choice' as const,
              default: layout.plans[0]?.key ?? '',
              choices: layout.plans.map((plan) => ({ value: plan.key, label: plan.title })),
            }
      const meta: EnvironmentMeta = {
        ...VALID,
        ...testCase.meta,
        parameters: [parameter],
      }
      expect(isEnvironmentMeta(meta), testCase.name).toBe(true)
      const resolved = resolveLayout(meta, testCase.parameters)
      expect(
        {
          plan_key: resolved.planKey,
          seats: resolved.seats.map((seat) => ({
            seat_id: seat.seatId,
            players: seat.players,
            restricted_builtin: seat.restrictedBuiltin,
          })),
          player_count: resolved.playerCount,
          seat_count: resolved.seatCount,
        },
        testCase.name,
      ).toEqual(testCase.layout)
    }
  })

  it('rejects every invalid shared layout fixture at the metadata guard', () => {
    for (const testCase of LAYOUT_FIXTURES.invalid) {
      expect(isEnvironmentMeta({ ...VALID, layout: testCase.layout }), testCase.name).toBe(false)
    }
  })
})
