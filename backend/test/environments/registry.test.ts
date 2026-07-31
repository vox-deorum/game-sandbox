import { describe, expect, it } from 'vitest'

import { EnvironmentMetadataError, EnvironmentRegistry } from '../../src/environments/registry.js'

describe('EnvironmentRegistry', () => {
  it('loads the generated artifact and every entry carries the served fields', () => {
    const registry = EnvironmentRegistry.load()
    const all = registry.list()
    expect(all.length).toBeGreaterThan(0)

    for (const meta of all) {
      expect(typeof meta.env_id).toBe('string')
      expect(typeof meta.display_name).toBe('string')
      expect(typeof meta.renderer).toBe('string')
      expect(Array.isArray(meta.human_players)).toBe(true)
      expect(meta.layout.kind === 'player_bounds' || meta.layout.kind === 'seat_plans').toBe(true)
      expect(typeof meta.step_limit_ms).toBe('number')
      expect(typeof meta.episode_limit_ms).toBe('number')
      expect(typeof meta.seat_order_matters).toBe('boolean')
      // pace_interval_ms and human_timeout_ms are int-or-null per the metadata contract.
      expect(meta.pace_interval_ms === null || typeof meta.pace_interval_ms === 'number').toBe(true)
      // view_interval_ms is likewise int-or-null (optional viewing cadence).
      expect(meta.view_interval_ms === null || typeof meta.view_interval_ms === 'number').toBe(true)
      // live_interval_ms is int-or-null too (optional live human throttle cadence).
      expect(meta.live_interval_ms === null || typeof meta.live_interval_ms === 'number').toBe(true)
    }
  })

  it('exposes Flappy Bird with its known pace cadence', () => {
    const registry = EnvironmentRegistry.load()
    const flappy = registry.get('flappy_bird')
    expect(flappy).toBeDefined()
    expect(flappy?.pace_interval_ms).toBe(50)
    expect(flappy?.human_players).toContain('player_0')
  })

  it('returns undefined for an unknown environment', () => {
    expect(EnvironmentRegistry.load().get('no_such_env')).toBeUndefined()
  })

  it('rejects metadata that is not a JSON array', () => {
    expect(() => EnvironmentRegistry.parse('{"env_id":"x"}')).toThrow(EnvironmentMetadataError)
  })

  it('rejects an entry with a missing field', () => {
    const bad = JSON.stringify([{ env_id: 'x', display_name: 'X' }])
    expect(() => EnvironmentRegistry.parse(bad)).toThrow(/wrong shape/)
  })

  it('rejects invalid JSON', () => {
    expect(() => EnvironmentRegistry.parse('not json')).toThrow(EnvironmentMetadataError)
  })
})
