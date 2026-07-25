import type { EnvParameter } from '@game-sandbox/schema/environment'
import { describe, expect, it } from 'vitest'

import {
  describeParameters,
  formatParameterValue,
  initializeParameters,
  validateParameters,
  visibleParameters,
} from '../src/lib/parameters.js'

const PARAMETERS: EnvParameter[] = [
  {
    name: 'players',
    title: 'Players',
    description: 'Players.',
    type: 'int',
    default: 1,
    min: 1,
    max: 1,
  },
  {
    name: 'gap',
    title: 'Pipe gap',
    description: 'Opening.',
    type: 'int',
    default: 100,
    min: 60,
    max: 200,
  },
  {
    name: 'mode',
    title: 'Mode',
    description: 'Rules.',
    type: 'choice',
    default: 'standard',
    choices: [{ value: 'standard', label: 'Standard' }],
  },
  {
    name: 'extras',
    title: 'Extras',
    description: 'Options.',
    type: 'multi_choice',
    default: [],
    choices: [
      { value: 'wind', label: 'Wind' },
      { value: 'night', label: 'Night' },
    ],
  },
]

describe('parameters', () => {
  it('hides fixed numeric and single-choice declarations but keeps multi-choice controls', () => {
    expect(visibleParameters(PARAMETERS).map((parameter) => parameter.name)).toEqual([
      'gap',
      'extras',
    ])
  })

  it('falls back safely to defaults and reports a blank numeric edit as invalid', () => {
    expect(initializeParameters(PARAMETERS, { gap: 999 })).toMatchObject({ gap: 100, players: 1 })
    expect(
      validateParameters(PARAMETERS, { players: 1, gap: '', mode: 'standard', extras: [] }).errors,
    ).toEqual({
      gap: expect.any(String),
    })
  })

  it('normalizes multi-choice values to declaration order and formats visible settings', () => {
    const checked = validateParameters(PARAMETERS, {
      players: 1,
      gap: 90,
      mode: 'standard',
      extras: ['night', 'wind'],
    })
    expect(checked.values.extras).toEqual(['wind', 'night'])
    const extras = PARAMETERS.find((parameter) => parameter.name === 'extras')
    const extrasValue = checked.values.extras
    if (extras === undefined || extrasValue === undefined) throw new Error('extras fixture missing')
    expect(formatParameterValue(extras, extrasValue)).toBe('Wind, Night')
  })

  it('describes only the visible settings, in declaration order, filling gaps with defaults', () => {
    expect(describeParameters(PARAMETERS, { players: 1, gap: 90, extras: ['night'] })).toEqual([
      { label: 'Pipe gap', value: '90' },
      { label: 'Extras', value: 'Night' },
    ])
    // A map missing a declared value still describes it, so a summary never has a blank row.
    expect(describeParameters(PARAMETERS, {})).toEqual([
      { label: 'Pipe gap', value: '100' },
      { label: 'Extras', value: 'None' },
    ])
    // Nothing adjustable means nothing to describe; the caller decides what to say instead.
    expect(describeParameters([PARAMETERS[0] as EnvParameter], { players: 1 })).toEqual([])
  })
})
