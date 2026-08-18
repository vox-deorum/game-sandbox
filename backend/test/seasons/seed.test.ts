/**
 * Seed coverage: a fresh backend stands up, per environment that declares presets, one hidden
 * template season per preset (closed gates, preset overrides as the parameter and LLM layers, and a
 * description naming the settings), plus a described Playground, while preset-less environments keep
 * exactly their one Playground row. Idempotency and the "templates appear only while the environment
 * is otherwise untouched" guard are exercised too.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EnvironmentRegistry } from '../../src/environments/registry.js'
import { DEFAULT_SEASON_LABEL, seedOpenSeasons } from '../../src/seasons/seed.js'
import { decodeSeasonConfig, type Storage } from '../../src/storage/index.js'
import { openSqliteStorage } from '../../src/storage/sqlite.js'
import { meta } from '../support/harness.js'

/** A registry with one preset-declaring environment and one preset-less environment. */
function registry(): EnvironmentRegistry {
  return EnvironmentRegistry.parse(
    JSON.stringify([
      meta({
        env_id: 'plateau',
        display_name: 'The Plateau',
        llm: true,
        layout: {
          kind: 'seat_plans',
          plans: [
            { key: 'solo', title: 'Solo', seats: [{ players: [0] }] },
            { key: 'band', title: 'Band', seats: [{ players: [0, 1] }] },
          ],
        },
        parameters: [
          {
            name: 'seat_plan',
            title: 'Seat plan',
            description: 'Seat-to-player layout for each game.',
            type: 'choice',
            default: 'solo',
            choices: [
              { value: 'solo', label: 'Solo' },
              { value: 'band', label: 'Band' },
            ],
          },
          {
            name: 'terrain',
            title: 'Terrain',
            description: 'Enables terrain.',
            type: 'bool',
            default: false,
          },
        ],
        presets: [
          { name: 'season_1', title: 'Season 1: The Walk', values: {} },
          {
            name: 'season_2',
            title: 'Season 2: The Band',
            values: { seat_plan: 'band', terrain: true },
            llm: true,
          },
        ],
      }),
      meta({ env_id: 'plain', display_name: 'The Plain' }),
    ]),
  )
}

function plateauOnly(): EnvironmentRegistry {
  return EnvironmentRegistry.parse(JSON.stringify([registry().get('plateau')]))
}

describe('seedOpenSeasons template seasons', () => {
  let dir: string
  let dbPath: string
  let storage: Storage

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gs-seed-'))
    dbPath = join(dir, 'sandbox.db')
    storage = await openSqliteStorage(dbPath)
  })

  afterEach(async () => {
    await storage.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('stands up one hidden template season per preset and describes the Playground', async () => {
    await seedOpenSeasons(storage, registry(), 1)

    const plateau = await storage.listSeasons({ envId: 'plateau', scope: 'all' })
    const playground = plateau.find((season) => season.label === DEFAULT_SEASON_LABEL)
    expect(playground?.submission_status).toBe('open')
    expect(playground?.play_status).toBe('open')
    expect(playground?.release_status).toBe('unreleased')
    expect(playground?.description_markdown).toBe(
      'A season for trying things out, playing with the Season 1: The Walk settings.',
    )

    const walk = plateau.find((season) => season.label === 'Season 1: The Walk')
    expect(walk?.submission_status).toBe('closed')
    expect(walk?.play_status).toBe('closed')
    expect(walk?.release_status).toBe('unreleased')
    expect(walk?.description_markdown).toBe(
      "Season 1: The Walk. This season uses the game's default settings.",
    )
    expect(decodeSeasonConfig(walk?.config ?? '{}').overrides).toBeUndefined()

    const band = plateau.find((season) => season.label === 'Season 2: The Band')
    expect(band?.description_markdown).toBe(
      'Season 2: The Band. Seat plan Band, Terrain On. The LLM API is available this season.',
    )
    const bandConfig = decodeSeasonConfig(band?.config ?? '{}')
    expect(bandConfig.overrides?.parameters).toEqual({ seat_plan: 'band', terrain: true })
    expect(bandConfig.overrides?.llm).toEqual({ enabled: true })
  })

  it('leaves preset-less environments with only the Playground season', async () => {
    await seedOpenSeasons(storage, registry(), 1)

    const plain = await storage.listSeasons({ envId: 'plain', scope: 'all' })
    expect(plain).toHaveLength(1)
    expect(plain[0]?.label).toBe(DEFAULT_SEASON_LABEL)
    expect(plain[0]?.description_markdown).toBeNull()
  })

  it('does not add a second batch on a re-run', async () => {
    await seedOpenSeasons(storage, registry(), 1)
    const first = await storage.listSeasons({ envId: 'plateau', scope: 'all' })
    expect(first).toHaveLength(3)

    await seedOpenSeasons(storage, registry(), 1)
    const second = await storage.listSeasons({ envId: 'plateau', scope: 'all' })
    expect(second.map((season) => season.id).sort()).toEqual(
      first.map((season) => season.id).sort(),
    )
    expect(second).toHaveLength(3)
  })

  it('does not seed templates once any other season exists', async () => {
    await storage.ensureOpenSeason('plateau', 1, { label: DEFAULT_SEASON_LABEL })
    await storage.createSeason({ env_id: 'plateau', deps_version: 1, label: 'Configured' })

    await seedOpenSeasons(storage, plateauOnly(), 1)

    const after = await storage.listSeasons({ envId: 'plateau', scope: 'all' })
    expect(after.map((season) => season.label).sort()).toEqual(['Configured', DEFAULT_SEASON_LABEL])
  })

  it('leaves the Playground description unset when no preset qualifies', async () => {
    const registry = EnvironmentRegistry.parse(
      JSON.stringify([
        meta({
          env_id: 'plateau',
          display_name: 'The Plateau',
          llm: true,
          parameters: [
            {
              name: 'players',
              title: 'Players',
              description: 'Number of players.',
              type: 'int',
              default: 1,
              min: 1,
              max: 1,
            },
            {
              name: 'terrain',
              title: 'Terrain',
              description: 'Enables terrain.',
              type: 'bool',
              default: false,
            },
          ],
          presets: [{ name: 'starter', title: 'Starter', values: { terrain: true }, llm: true }],
        }),
      ]),
    )

    await seedOpenSeasons(storage, registry, 1)

    const seasons = await storage.listSeasons({ envId: 'plateau', scope: 'all' })
    const playground = seasons.find((season) => season.label === DEFAULT_SEASON_LABEL)
    // No empty-values, no-LLM preset exists, so the Playground stays undescribed even though the
    // env's template still stands up.
    expect(playground?.description_markdown).toBeNull()
    expect(seasons.map((season) => season.label).sort()).toEqual([DEFAULT_SEASON_LABEL, 'Starter'])
  })

  it('never replaces a Playground description an operator has saved', async () => {
    await seedOpenSeasons(storage, plateauOnly(), 1)
    const templates = await storage.listSeasons({ envId: 'plateau', scope: 'all' })
    for (const season of templates) {
      if (season.label === DEFAULT_SEASON_LABEL) {
        await storage.setSeasonDescription(season.id, 'The instructor rewrote this.')
      } else {
        await storage.deleteSeason(season.id)
      }
    }

    await seedOpenSeasons(storage, plateauOnly(), 1)

    const after = await storage.listSeasons({ envId: 'plateau', scope: 'all' })
    const playground = after.find((season) => season.label === DEFAULT_SEASON_LABEL)
    expect(playground?.description_markdown).toBe('The instructor rewrote this.')
    expect(after.map((season) => season.label).sort()).toEqual([
      DEFAULT_SEASON_LABEL,
      'Season 1: The Walk',
      'Season 2: The Band',
    ])
  })
})
