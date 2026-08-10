import { describe, expect, it } from 'vitest'

import { decodeDynamic, decodeStatic } from './overlay.js'
import { firstDynamic, header, states } from './test-helpers.js'

function clonedFrame(): { v: number; d: { t: number; c: string[]; p: string; z: string } } {
  return structuredClone(states[0]) as {
    v: number
    d: { t: number; c: string[]; p: string; z: string }
  }
}

function clonedHeader(): { v: number; s: Record<string, unknown> } {
  return structuredClone(header.overlay_static) as { v: number; s: Record<string, unknown> }
}

describe('Three Branches compact overlay decoder', () => {
  it('decodes friendly meter-space words and derived state', () => {
    expect(firstDynamic.characters).toHaveLength(6)
    expect(firstDynamic.characters[0]?.id).toBe('npc_0')
    expect(firstDynamic.characters.at(-1)?.id).toBe('visitor')
    expect(firstDynamic.village.ground).toHaveLength(100)
    expect(firstDynamic.village.ground[25]).toHaveLength(100)
    expect(firstDynamic.phase).toBe('day')
    expect(firstDynamic.terminal).toBe(false)
  })

  it('rejects malformed key sets, records, ranges, grid, and terminal states', () => {
    const cases: Array<
      [
        string,
        (
          frame: ReturnType<typeof clonedFrame>,
          staticHeader: ReturnType<typeof clonedHeader>,
        ) => void,
      ]
    > = [
      ['unexpected fields', (frame) => Object.assign(frame, { extra: null })],
      ['roster order', (frame) => frame.d.c.pop()],
      ['13 characters', (frame) => (frame.d.c[0] = 'short')],
      ['prop state', (frame) => (frame.d.p = 'z'.repeat(31))],
      ['ground row', (_frame, staticHeader) => ((staticHeader.s.g as string[])[0] = 'o00')],
      [
        'terminal flag',
        (frame) => {
          frame.d.t = 1199
          frame.d.z = '1'
        },
      ],
      ['cast size', (_frame, staticHeader) => (staticHeader.s.a = '10')],
      [
        'movement',
        (frame) => (frame.d.c[0] = `${frame.d.c[0]?.slice(0, 9)}2t${frame.d.c[0]?.slice(11)}`),
      ],
    ]
    for (const [message, mutate] of cases) {
      const frame = clonedFrame()
      const staticHeader = clonedHeader()
      mutate(frame, staticHeader)
      expect(() => decodeDynamic(frame, decodeStatic(staticHeader))).toThrow(message)
    }
  })

  it('rejects every static record class, inventory count, and grid run shape', () => {
    const cases: Array<[string, (staticHeader: ReturnType<typeof clonedHeader>) => void]> = [
      [
        'static data has unexpected fields',
        (staticHeader) => delete (staticHeader as { v?: number }).v,
      ],
      [
        'static data has unexpected fields',
        (staticHeader) => Object.assign(staticHeader, { extra: true }),
      ],
      ['static layout has unexpected fields', (staticHeader) => delete staticHeader.s.a],
      [
        'static layout has unexpected fields',
        (staticHeader) => Object.assign(staticHeader.s, { extra: true }),
      ],
      ['cast and daynight setting', (staticHeader) => (staticHeader.s.a = '5x')],
      ['exactly four channels', (staticHeader) => (staticHeader.s.c = [])],
      ['at least one footpath', (staticHeader) => (staticHeader.s.f = [])],
      ['at least one bridge', (staticHeader) => (staticHeader.s.b = [])],
      ['exactly seven buildings', (staticHeader) => (staticHeader.s.h = [])],
      ['exactly 31 props', (staticHeader) => (staticHeader.s.p = [])],
      ['scenery must be a list', (staticHeader) => (staticHeader.s.n = 'pine:00000001')],
      ['channel is malformed', (staticHeader) => ((staticHeader.s.c as string[])[0] = 'short')],
      ['road is malformed', (staticHeader) => (staticHeader.s.r = 'short')],
      [
        'bridge record must be 13 characters',
        (staticHeader) => ((staticHeader.s.b as string[])[0] = 'short'),
      ],
      [
        'building record must be 21 characters',
        (staticHeader) => ((staticHeader.s.h as string[])[0] = 'short'),
      ],
      [
        'prop record must be nine characters',
        (staticHeader) => ((staticHeader.s.p as string[])[0] = 'short'),
      ],
      [
        'scenery record is malformed',
        (staticHeader) => ((staticHeader.s.n as string[])[0] = 'Pine:00000001'),
      ],
      ['spawn lies outside', (staticHeader) => (staticHeader.s.x = 'zzz000')],
      ['prop lies outside', (staticHeader) => ((staticHeader.s.p as string[])[0] = 'zzz000000')],
      [
        'prop rotation is outside',
        (staticHeader) => {
          const props = staticHeader.s.p as string[]
          props[0] = `${props[0]?.slice(0, 6)}zzz`
        },
      ],
      [
        'bridge lengths must be positive',
        (staticHeader) => {
          const bridges = staticHeader.s.b as string[]
          bridges[0] = `${bridges[0]?.slice(0, 9)}00${bridges[0]?.slice(11)}`
        },
      ],
      ['ground must contain exactly 100 rows', (staticHeader) => (staticHeader.s.g = [])],
      ['ground row is malformed', (staticHeader) => ((staticHeader.s.g as string[])[0] = '')],
      [
        'ground run must be 2 base36 characters',
        (staticHeader) => ((staticHeader.s.g as string[])[0] = 'o0!'),
      ],
      [
        'ground row has an invalid run',
        (staticHeader) => ((staticHeader.s.g as string[])[0] = 'q2s'),
      ],
      [
        'ground row has an invalid run',
        (staticHeader) => ((staticHeader.s.g as string[])[0] = 'o01o01'),
      ],
      [
        'ground row must sum to 100 cells',
        (staticHeader) => ((staticHeader.s.g as string[])[0] = 'o01'),
      ],
    ]
    for (const [message, mutate] of cases) {
      const staticHeader = clonedHeader()
      mutate(staticHeader)
      expect(() => decodeStatic(staticHeader)).toThrow(message)
    }
  })

  it('rejects dynamic key sets, primitive fields, character points, and target disagreement', () => {
    const staticOverlay = decodeStatic(clonedHeader())
    const cases: Array<[string, (frame: ReturnType<typeof clonedFrame>) => void]> = [
      ['dynamic frame has unexpected fields', (frame) => delete (frame as { v?: number }).v],
      ['dynamic frame has an unsupported version', (frame) => (frame.v = 2)],
      [
        'dynamic state has unexpected fields',
        (frame) => delete (frame.d as Record<string, unknown>).t,
      ],
      ['dynamic state has unexpected fields', (frame) => Object.assign(frame.d, { extra: true })],
      ['tick must be within the day', (frame) => (frame.d.t = 0)],
      ['terminal flag must be 0 or 1', (frame) => (frame.d.z = 'x')],
      [
        'character records must follow roster order',
        (frame) => ((frame.d as Record<string, unknown>).c = 'bad'),
      ],
      [
        'character x must be 3 base36 characters',
        (frame) => (frame.d.c[0] = `A${frame.d.c[0]?.slice(1)}`),
      ],
      ['character lies outside', (frame) => (frame.d.c[0] = `zzz000${frame.d.c[0]?.slice(6)}`)],
      [
        'expression and target do not agree',
        (frame) => (frame.d.c[0] = `${frame.d.c[0]?.slice(0, 11)}1x`),
      ],
      ['prop states must contain exactly 31 characters', (frame) => (frame.d.p = '0')],
      ['prop state must be 1 base36 characters', (frame) => (frame.d.p = `!${frame.d.p.slice(1)}`)],
    ]
    for (const [message, mutate] of cases) {
      const frame = clonedFrame()
      mutate(frame)
      expect(() => decodeDynamic(frame, staticOverlay)).toThrow(message)
    }
  })

  it('rejects invalid use targets, duplicate holders, moving use, and headings', () => {
    const invalidTarget = clonedFrame()
    invalidTarget.d.c[0] = `${invalidTarget.d.c[0]?.slice(0, 11)}az`
    expect(() => decodeDynamic(invalidTarget, decodeStatic(clonedHeader()))).toThrow('use target')

    const duplicateHolder = clonedFrame()
    for (const index of [0, 1]) {
      const character = duplicateHolder.d.c[index] ?? ''
      duplicateHolder.d.c[index] = `${character.slice(0, 9)}00a0`
    }
    expect(() => decodeDynamic(duplicateHolder, decodeStatic(clonedHeader()))).toThrow(
      'multiple holders',
    )

    const movingUse = clonedFrame()
    movingUse.d.c[0] = `${movingUse.d.c[0]?.slice(0, 9)}01a0`
    expect(() => decodeDynamic(movingUse, decodeStatic(clonedHeader()))).toThrow('movement')

    const invalidHeading = clonedFrame()
    invalidHeading.d.c[0] = `${invalidHeading.d.c[0]?.slice(0, 6)}zzz${invalidHeading.d.c[0]?.slice(9)}`
    expect(() => decodeDynamic(invalidHeading, decodeStatic(clonedHeader()))).toThrow('outside')
  })

  it('requires the split v1 header and state shapes', () => {
    const frame = clonedFrame()
    expect(() => decodeDynamic(frame)).toThrow('static data is required')
    expect(() =>
      decodeDynamic({ ...frame, s: clonedHeader().s }, decodeStatic(clonedHeader())),
    ).toThrow('must not contain static')
    expect(() => decodeDynamic({ ...frame, v: 2 }, decodeStatic(clonedHeader()))).toThrow(
      'unsupported version',
    )
    expect(() => decodeStatic({ ...clonedHeader(), v: 2 })).toThrow('unsupported version')
  })

  it('does not retain consumer mutations between decodes', () => {
    const firstStatic = decodeStatic(clonedHeader())
    const firstRow = firstStatic.village.ground[0]
    const firstBuilding = firstStatic.village.buildings[0]
    expect(firstRow).toBeDefined()
    expect(firstBuilding).toBeDefined()
    if (!firstRow || !firstBuilding) throw new Error('fixture static overlay is incomplete')
    firstRow[0] = 'changed'
    firstBuilding.center.x = -1
    const secondStatic = decodeStatic(clonedHeader())
    expect(secondStatic.village.ground[0]?.[0]).not.toBe('changed')
    expect(secondStatic.village.buildings[0]?.center.x).not.toBe(-1)

    const first = decodeDynamic(clonedFrame(), secondStatic)
    const dynamicFirstRow = first.village.ground[0]
    expect(dynamicFirstRow).toBeDefined()
    if (!dynamicFirstRow) throw new Error('fixture dynamic overlay is incomplete')
    dynamicFirstRow[0] = 'changed'
    const second = decodeDynamic(clonedFrame(), secondStatic)
    expect(second.village.ground[0]?.[0]).not.toBe('changed')
  })
})
