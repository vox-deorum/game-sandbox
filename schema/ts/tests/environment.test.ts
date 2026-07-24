import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  type EnvironmentMeta,
  type EnvParameter,
  isEnvironmentMeta,
  isEnvParameter,
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
    issue_names: string[]
  }>
}

const PARAMETER_FIXTURES = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as ParameterFixtures

const VALID: EnvironmentMeta = {
  env_id: 'flappy_bird',
  display_name: 'Flappy Bird',
  description: 'A paced single-human clone.',
  min_slots: 1,
  max_slots: 4,
  human_slots: ['player_0'],
  human_timeout_ms: null,
  recommended_episode_ticks: 1000,
  pace_interval_ms: 50,
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
}

describe('isEnvironmentMeta', () => {
  it('accepts a field-complete entry', () => {
    expect(isEnvironmentMeta(VALID)).toBe(true)
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

  it('rejects a non-numeric view_interval_ms', () => {
    expect(isEnvironmentMeta({ ...VALID, view_interval_ms: '2000' })).toBe(false)
  })

  it('rejects a non-numeric live_interval_ms', () => {
    expect(isEnvironmentMeta({ ...VALID, live_interval_ms: '900' })).toBe(false)
  })

  it('rejects a non-object', () => {
    expect(isEnvironmentMeta(null)).toBe(false)
    expect(isEnvironmentMeta('flappy_bird')).toBe(false)
  })

  it('rejects an entry missing a field', () => {
    const { renderer: _omitted, ...withoutRenderer } = VALID
    expect(isEnvironmentMeta(withoutRenderer)).toBe(false)
  })

  it('rejects an entry whose human_slots is not a string array', () => {
    expect(isEnvironmentMeta({ ...VALID, human_slots: [0, 1] })).toBe(false)
  })

  it('rejects an entry without parameter declarations', () => {
    const { parameters: _omitted, ...withoutParameters } = VALID
    expect(isEnvironmentMeta(withoutParameters)).toBe(false)
  })

  it('rejects metadata without the synthesized seats declaration', () => {
    expect(isEnvironmentMeta({ ...VALID, parameters: VALID.parameters.slice(1) })).toBe(false)
  })

  it('rejects a synthesized seats declaration that disagrees with the slot bounds', () => {
    expect(isEnvironmentMeta({ ...VALID, max_slots: 3 })).toBe(false)
  })

  it('rejects malformed parameter declarations', () => {
    expect(
      isEnvironmentMeta({
        ...VALID,
        parameters: [{ ...PARAMETER_FIXTURES.declarations[0], min: 4, max: 1 }],
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
  const declarations = new Map(
    PARAMETER_FIXTURES.declarations.map((declaration) => [declaration.name, declaration]),
  )

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
      expect(result.issues.map((issue) => issue.name)).toEqual(testCase.issue_names)
    }
  })
})

describe('validateCompleteParameters', () => {
  const COMPLETE_PARAMETERS = {
    seats: 2,
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
        seats: 2,
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
