import type { EnvParameter } from '@game-sandbox/schema/environment'
import { describe, expect, it } from 'vitest'

import {
  formatParameterValue,
  initializeParameters,
  resolvedSeatCount,
  seatCountOf,
  validateParameters,
  visibleParameters,
} from '../src/lib/parameters.js'

const PARAMETERS: EnvParameter[] = [
  {
    name: 'seats',
    title: 'Seats',
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
    expect(initializeParameters(PARAMETERS, { gap: 999 })).toMatchObject({ gap: 100, seats: 1 })
    expect(
      validateParameters(PARAMETERS, { seats: 1, gap: '', mode: 'standard', extras: [] }).errors,
    ).toEqual({
      gap: expect.any(String),
    })
  })

  it('normalizes multi-choice values to declaration order and formats visible settings', () => {
    const checked = validateParameters(PARAMETERS, {
      seats: 1,
      gap: 90,
      mode: 'standard',
      extras: ['night', 'wind'],
    })
    expect(checked.values.extras).toEqual(['wind', 'night'])
    const extras = PARAMETERS.find((parameter) => parameter.name === 'extras')
    const extrasValue = checked.values.extras
    if (extras === undefined || extrasValue === undefined) throw new Error('extras fixture missing')
    expect(formatParameterValue(extras, extrasValue)).toBe('Wind, Night')
    expect(resolvedSeatCount(PARAMETERS, checked.values, 4)).toBe(1)
  })

  it('treats a seats value the declaration rejects as no answer rather than a seat count', () => {
    const variable: EnvParameter[] = [
      {
        name: 'seats',
        title: 'Seats',
        description: 'Players.',
        type: 'int',
        default: 4,
        min: 2,
        max: 6,
      },
    ]
    expect(seatCountOf(variable, { seats: 5 })).toBe(5)
    // Out of range, non-integer, empty (a cleared numeric field), and absent all mean "not a seat
    // count", so a caller can hold its last valid answer instead of resizing a grid mid-edit.
    for (const rejected of [99, 1, 4.5, '', '5', true, undefined]) {
      expect(seatCountOf(variable, { seats: rejected }), String(rejected)).toBeUndefined()
    }
    expect(seatCountOf([], {})).toBeUndefined()
    expect(resolvedSeatCount(variable, { seats: 99 }, 6)).toBe(6)
  })
})
