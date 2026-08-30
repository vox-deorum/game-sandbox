import { describe, expect, it, vi } from 'vitest'

import { createLogBuffer } from '../../src/logging/log-buffer.js'

describe('LogBuffer', () => {
  it('captures ordered, timestamped source entries while forwarding the full message to its sink', () => {
    const sink = vi.fn()
    const clock = vi
      .fn<() => Date>()
      .mockReturnValueOnce(new Date('2026-08-29T01:02:03.000Z'))
      .mockReturnValueOnce(new Date('2026-08-29T01:02:04.000Z'))
    const logs = createLogBuffer({ bootId: 'boot-1', clock, sink })
    logs.write('main', 'started', 'info')
    logs.write('auth', 'profile sync degraded', 'warn')

    expect(sink).toHaveBeenCalledWith('started')
    expect(logs.query()).toMatchObject({
      bootId: 'boot-1',
      oldestSeq: 1,
      latestSeq: 2,
      retainedCount: 2,
      sources: ['main', 'auth'],
      entries: [
        { seq: 1, time: '2026-08-29T01:02:03.000Z', source: 'main', level: 'info' },
        { seq: 2, time: '2026-08-29T01:02:04.000Z', source: 'auth', level: 'warn' },
      ],
    })
  })

  it('keeps capture nonthrowing when its sink or clock fails', () => {
    const logs = createLogBuffer({
      sink: () => {
        throw new Error('stderr unavailable')
      },
      clock: () => {
        throw new Error('clock unavailable')
      },
    })

    expect(() => logs.write('main', 'still running', 'info')).not.toThrow()
    expect(logs.query().entries).toEqual([])
  })

  it('does not create a cursor gap when a failed capture is followed by a successful one', () => {
    const clock = vi
      .fn<() => Date>()
      .mockImplementationOnce(() => {
        throw new Error('clock unavailable')
      })
      .mockReturnValueOnce(new Date('2026-08-29T01:02:03.000Z'))
    const logs = createLogBuffer({ clock, sink: () => {} })

    logs.write('main', 'lost to the clock', 'info')
    logs.write('auth', 'captured after recovery', 'warn')

    expect(logs.query({ afterSeq: 0 })).toMatchObject({
      oldestSeq: 1,
      latestSeq: 1,
      historyTruncated: false,
      sources: ['auth'],
      entries: [
        expect.objectContaining({
          seq: 1,
          source: 'auth',
          message: 'captured after recovery',
        }),
      ],
    })
  })

  it('stores a 4000-code-point copy while preserving an original Unicode message for stderr', () => {
    const sink = vi.fn()
    const logs = createLogBuffer({ sink })
    const message = `${'🙂'.repeat(4000)}tail`
    logs.write('workflow', message, 'error')

    expect(sink).toHaveBeenCalledWith(message)
    const stored = logs.query().entries[0]?.message ?? ''
    expect(Array.from(stored)).toHaveLength(4000)
    expect(stored.endsWith('…')).toBe(true)
  })

  it('filters exactly and returns detached snapshots', () => {
    const logs = createLogBuffer({ sink: () => {} })
    logs.write('main', 'Alpha service started', 'info')
    logs.write('auth', 'alpha profile unavailable', 'warn')
    logs.write('auth', 'login failed', 'error')

    expect(logs.query({ level: 'warn', source: 'auth', q: 'ALPHA' }).entries).toEqual([
      expect.objectContaining({ seq: 2, message: 'alpha profile unavailable' }),
    ])
    expect(logs.query({ afterSeq: 2 }).entries.map((entry) => entry.seq)).toEqual([3])
    const snapshot = logs.query()
    const first = snapshot.entries[0]
    expect(first).toBeDefined()
    if (first === undefined) throw new Error('expected an entry')
    first.message = 'mutated'
    expect(logs.query().entries[0]).toMatchObject({ message: 'Alpha service started' })
  })

  it('evicts oldest entries by encoded byte budget while retaining source history and cursor truth', () => {
    const logs = createLogBuffer({ sink: () => {} })
    logs.write('auth', 'observed before eviction', 'info')
    for (let i = 0; i < 400; i++) logs.write('submission', `${i}:${'🙂'.repeat(4000)}`, 'info')

    const snapshot = logs.query()
    expect(snapshot.retainedBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(snapshot.oldestSeq).toBeGreaterThan(1)
    expect(snapshot.latestSeq).toBe(401)
    expect(snapshot.sources).toEqual(['auth', 'submission'])
    expect(snapshot.entries.some((entry) => entry.source === 'auth')).toBe(false)
    expect(snapshot.retainedBytes).toBe(
      snapshot.entries.reduce(
        (total, entry) => total + Buffer.byteLength(JSON.stringify(entry), 'utf8'),
        0,
      ),
    )
    const oldest = snapshot.oldestSeq
    expect(oldest).not.toBeNull()
    if (oldest === null) throw new Error('expected retained entries')
    expect(logs.query({ afterSeq: oldest - 1 }).historyTruncated).toBe(false)
    expect(logs.query({ afterSeq: oldest - 2 }).historyTruncated).toBe(true)
  })

  it('has no entry-count limit below the byte budget', () => {
    const logs = createLogBuffer({ sink: () => {} })
    for (let i = 0; i < 5_001; i++) logs.write('main', 'ok', 'info')

    expect(logs.query()).toMatchObject({
      oldestSeq: 1,
      latestSeq: 5_001,
      retainedCount: 5_001,
    })
  })

  it('reports the empty capture boundary', () => {
    expect(createLogBuffer({ bootId: 'fresh', sink: () => {} }).query()).toMatchObject({
      bootId: 'fresh',
      entries: [],
      oldestSeq: null,
      latestSeq: 0,
      historyTruncated: false,
      retainedCount: 0,
      retainedBytes: 0,
      sources: [],
    })
  })
})
