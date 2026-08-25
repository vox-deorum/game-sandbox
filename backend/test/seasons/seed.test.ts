/**
 * Seed coverage: a fresh backend stands up, per environment that declares presets, one hidden
 * template season per preset (closed gates, preset overrides as the parameter and LLM layers, and a
 * description naming the settings), plus a described Playground, while preset-less environments keep
 * exactly their one Playground row. Idempotency, the per-preset fill-in, and the "hands off a
 * configured environment" guard (provenance + real configuration signals) are exercised too.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EnvironmentRegistry } from '../../src/environments/registry.js'
import { DEFAULT_SEASON_LABEL, seedOpenSeasons } from '../../src/seasons/seed.js'
import { decodeSeasonConfig, type Storage, templateSourceFor } from '../../src/storage/index.js'
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

  it('does not seed templates beside a season the seed did not create', async () => {
    await storage.ensureOpenSeason('plateau', 1, { label: DEFAULT_SEASON_LABEL })
    // An operator-made row (no provenance marker) means the environment was configured by a human
    // even though it is otherwise content-free, so the seed stays out.
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

  it('never replaces a Playground description an operator has saved, and keeps deleted templates gone', async () => {
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
    // The arc was planted by the first boot, so the operator's deletions of the templates are
    // respected instead of being recreated on this boot.
    expect(after.map((season) => season.label).sort()).toEqual([DEFAULT_SEASON_LABEL])
  })

  it('lists the fresh arc in declaration order after the Playground', async () => {
    await seedOpenSeasons(storage, plateauOnly(), 1)

    const plateau = await storage.listSeasons({ envId: 'plateau', scope: 'all' })
    expect(plateau.map((season) => season.label)).toEqual([
      DEFAULT_SEASON_LABEL,
      'Season 1: The Walk',
      'Season 2: The Band',
    ])
  })

  it('fills in a template when a later release adds a preset, without duplicating the arc', async () => {
    await seedOpenSeasons(storage, plateauOnly(), 1)
    expect(await storage.listSeasons({ envId: 'plateau', scope: 'all' })).toHaveLength(3)
    // A release that adds a preset clears the planted marker (the deployment's update step), so the
    // next boot plants the new release's arc.
    await storage.setTemplateArcPlanted('plateau', false)

    const plateau = registry().get('plateau')
    if (plateau === undefined) throw new Error('plateau missing from the test registry')
    const extended = EnvironmentRegistry.parse(
      JSON.stringify([
        {
          ...plateau,
          presets: [
            ...(plateau.presets ?? []),
            {
              name: 'season_3',
              title: 'Season 3: The Multiplayer',
              values: { seat_plan: 'band' },
            },
          ],
        },
      ]),
    )
    await seedOpenSeasons(storage, extended, 1)

    const after = await storage.listSeasons({ envId: 'plateau', scope: 'all' })
    expect(after).toHaveLength(4)
    const multiplayer = after.find((season) => season.label === 'Season 3: The Multiplayer')
    expect(multiplayer?.description_markdown).toBe('Season 3: The Multiplayer. Seat plan Band.')
    const labels = after.map((season) => season.label)
    for (const label of [
      DEFAULT_SEASON_LABEL,
      'Season 1: The Walk',
      'Season 2: The Band',
      'Season 3: The Multiplayer',
    ]) {
      expect(labels.filter((candidate) => candidate === label)).toHaveLength(1)
    }
  })

  it('re-labels a template when its preset title changes instead of duplicating it', async () => {
    await seedOpenSeasons(storage, plateauOnly(), 1)

    const plateau = registry().get('plateau')
    if (plateau === undefined) throw new Error('plateau missing from the test registry')
    const renamed = EnvironmentRegistry.parse(
      JSON.stringify([
        {
          ...plateau,
          presets: (plateau.presets ?? []).map((preset) =>
            preset.name === 'season_1' ? { ...preset, title: 'Season 1: The Long Walk' } : preset,
          ),
        },
      ]),
    )
    await seedOpenSeasons(storage, renamed, 1)

    const after = await storage.listSeasons({ envId: 'plateau', scope: 'all' })
    expect(after).toHaveLength(3)
    expect(after.map((season) => season.label).sort()).toEqual([
      DEFAULT_SEASON_LABEL,
      'Season 1: The Long Walk',
      'Season 2: The Band',
    ])
    // The still-seed-written description follows the new title; only a hand-authored one is spared.
    const renamedTemplate = after.find((season) => season.label === 'Season 1: The Long Walk')
    expect(renamedTemplate?.description_markdown).toBe(
      "Season 1: The Long Walk. This season uses the game's default settings.",
    )
  })

  it('finishes an interrupted template batch instead of being skipped forever', async () => {
    await storage.ensureOpenSeason('plateau', 1, { label: DEFAULT_SEASON_LABEL })
    // A crash after the first insert of a previous boot left one template for the first preset.
    await storage.createSeason({
      env_id: 'plateau',
      deps_version: 1,
      label: 'Season 1: The Walk',
      description_markdown: "Season 1: The Walk. This season uses the game's default settings.",
      template_source: templateSourceFor('season_1'),
    })

    await seedOpenSeasons(storage, plateauOnly(), 1)

    const after = await storage.listSeasons({ envId: 'plateau', scope: 'all' })
    const labels = after.map((season) => season.label)
    for (const label of [DEFAULT_SEASON_LABEL, 'Season 1: The Walk', 'Season 2: The Band']) {
      expect(labels.filter((candidate) => candidate === label)).toHaveLength(1)
    }
    const band = after.find((season) => season.label === 'Season 2: The Band')
    expect(band?.description_markdown).toBe(
      'Season 2: The Band. Seat plan Band, Terrain On. The LLM API is available this season.',
    )
  })

  it('stays hands-off an environment whose Playground is configured, and never restamps it', async () => {
    await seedOpenSeasons(storage, plateauOnly(), 1)
    const before = await storage.listSeasons({ envId: 'plateau', scope: 'all' })
    const playground = before.find((season) => season.label === DEFAULT_SEASON_LABEL)
    if (playground === undefined) throw new Error(`no ${DEFAULT_SEASON_LABEL} in test setup`)
    await storage.updateSeasonConfig(playground.id, {
      deps_version: 1,
      matches: [],
      overrides: { llm: { enabled: true } },
    })
    // Clearing the description after an operator configures the Playground must stay cleared: a
    // configured environment both stops receiving templates and never gets seed prose written.
    await storage.setSeasonDescription(playground.id, null)

    await seedOpenSeasons(storage, plateauOnly(), 1)

    const after = await storage.listSeasons({ envId: 'plateau', scope: 'all' })
    expect(after).toHaveLength(before.length)
    const untouchedPlayground = after.find((season) => season.label === DEFAULT_SEASON_LABEL)
    expect(untouchedPlayground?.description_markdown).toBeNull()
  })

  it('does not seed beside an operator-owned open season', async () => {
    const operatorSeason = await storage.createSeason({
      env_id: 'plateau',
      deps_version: 1,
      label: 'Fall 2026',
    })
    await storage.setSubmissionStatus(operatorSeason.id, 'open')

    await seedOpenSeasons(storage, plateauOnly(), 1)

    const after = await storage.listSeasons({ envId: 'plateau', scope: 'all' })
    expect(after).toHaveLength(1)
    expect(after[0]?.label).toBe('Fall 2026')
    expect(after[0]?.description_markdown).toBeNull()
  })

  it('keeps an environment with no open season supplied by the seed even after configuration', async () => {
    await seedOpenSeasons(storage, plateauOnly(), 1)
    const before = await storage.listSeasons({ envId: 'plateau', scope: 'all' })
    const playground = before.find((season) => season.label === DEFAULT_SEASON_LABEL)
    if (playground === undefined) throw new Error(`no ${DEFAULT_SEASON_LABEL} in test setup`)
    await storage.setSubmissionStatus(playground.id, 'closed')
    await storage.setPlayStatus(playground.id, 'closed')
    await storage.createSeason({ env_id: 'plateau', deps_version: 1, label: 'Fall 2026' })

    await seedOpenSeasons(storage, plateauOnly(), 1)

    const after = await storage.listSeasons({ envId: 'plateau', scope: 'all' })
    const open = after.find((season) => season.submission_status === 'open')
    expect(open).toBeDefined()
    expect(open?.label).toBe(DEFAULT_SEASON_LABEL)
    expect(open?.description_markdown).toBeNull()
    expect(after.filter((season) => season.template_source === null).map((s) => s.label)).toEqual([
      'Fall 2026',
    ])
  })

  it('keeps a preset named "playground" from colliding with the Playground marker', async () => {
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
          presets: [{ name: 'playground', title: 'The Playground Arc', values: { terrain: true } }],
        }),
      ]),
    )

    await seedOpenSeasons(storage, registry, 1)
    const first = await storage.listSeasons({ envId: 'plateau', scope: 'all' })
    expect(first).toHaveLength(2)
    // The preset's template carries its own namespaced provenance, not the Playground marker, and
    // the Playground row keeps its label.
    expect(first.find((season) => season.label === DEFAULT_SEASON_LABEL)).toBeDefined()
    expect(first.find((season) => season.label === 'The Playground Arc')?.template_source).toBe(
      templateSourceFor('playground'),
    )

    // The template's overrides do not falsely mark the environment configured: a preset added by a
    // later release still reaches it after the release clears the planted marker.
    await storage.setTemplateArcPlanted('plateau', false)
    const plateau = registry.get('plateau')
    if (plateau === undefined) throw new Error('plateau missing from the test registry')
    const extended = EnvironmentRegistry.parse(
      JSON.stringify([
        {
          ...plateau,
          presets: [
            { name: 'playground', title: 'The Playground Arc', values: { terrain: true } },
            { name: 'season_1', title: 'Season 1: The Walk', values: {} },
          ],
        },
      ]),
    )
    await seedOpenSeasons(storage, extended, 1)

    const after = await storage.listSeasons({ envId: 'plateau', scope: 'all' })
    expect(after.map((season) => season.label).sort()).toEqual([
      DEFAULT_SEASON_LABEL,
      'Season 1: The Walk',
      'The Playground Arc',
    ])
  })

  it('leaves an operator-opened, renamed template alone and stamps the Playground', async () => {
    // Opening a template's gates is the documented workflow (its description becomes public), so on
    // the next boot the seed must not rewrite the live season or stamp its description onto it.
    await seedOpenSeasons(storage, plateauOnly(), 1)
    const before = await storage.listSeasons({ envId: 'plateau', scope: 'all' })
    const playground = before.find((season) => season.label === DEFAULT_SEASON_LABEL)
    const walk = before.find((season) => season.label === 'Season 1: The Walk')
    if (playground === undefined || walk === undefined) {
      throw new Error('playground and walk missing from the test setup')
    }
    await storage.setSubmissionStatus(playground.id, 'closed')
    await storage.setPlayStatus(playground.id, 'closed')
    await storage.setSubmissionStatus(walk.id, 'open')
    await storage.setSeasonDescription(walk.id, null)
    await storage.setSeasonDescription(playground.id, null)
    await storage.setSeasonLabel(walk.id, 'Fall 2026')

    await seedOpenSeasons(storage, plateauOnly(), 1)

    const after = await storage.listSeasons({ envId: 'plateau', scope: 'all' })
    const reopenedWalk = after.find((season) => season.id === walk.id)
    expect(reopenedWalk?.label).toBe('Fall 2026')
    expect(reopenedWalk?.description_markdown).toBeNull()
    // The Playground description lands on the Playground row (by its marker), never on the open
    // template that `ensureOpenSeason` happened to return.
    const stamped = after.find((season) => season.id === playground.id)
    expect(stamped?.description_markdown).toBe(
      'A season for trying things out, playing with the Season 1: The Walk settings.',
    )
  })

  it('propagates a preset value change to its planted template', async () => {
    await seedOpenSeasons(storage, plateauOnly(), 1)

    const plateau = registry().get('plateau')
    if (plateau === undefined) throw new Error('plateau missing from the test registry')
    const changed = EnvironmentRegistry.parse(
      JSON.stringify([
        {
          ...plateau,
          presets: (plateau.presets ?? []).map((preset) =>
            preset.name === 'season_2'
              ? { ...preset, values: { seat_plan: 'band', terrain: false } }
              : preset,
          ),
        },
      ]),
    )
    await seedOpenSeasons(storage, changed, 1)

    const after = await storage.listSeasons({ envId: 'plateau', scope: 'all' })
    const band = after.find((season) => season.label === 'Season 2: The Band')
    const config = decodeSeasonConfig(band?.config ?? '{}')
    expect(config.overrides?.parameters).toEqual({ seat_plan: 'band', terrain: false })
    expect(band?.description_markdown).toBe(
      'Season 2: The Band. Seat plan Band, Terrain Off. The LLM API is available this season.',
    )
  })

  it('leaves a template whose description an operator rewrote fully alone', async () => {
    await seedOpenSeasons(storage, plateauOnly(), 1)
    const before = await storage.listSeasons({ envId: 'plateau', scope: 'all' })
    const walk = before.find((season) => season.label === 'Season 1: The Walk')
    if (walk === undefined) throw new Error('walk missing from the test setup')
    await storage.setSeasonDescription(walk.id, 'The official fall assignment.')

    const plateau = registry().get('plateau')
    if (plateau === undefined) throw new Error('plateau missing from the test registry')
    const renamed = EnvironmentRegistry.parse(
      JSON.stringify([
        {
          ...plateau,
          presets: (plateau.presets ?? []).map((preset) =>
            preset.name === 'season_1' ? { ...preset, title: 'Season 1: The Long Walk' } : preset,
          ),
        },
      ]),
    )
    await seedOpenSeasons(storage, renamed, 1)

    const after = await storage.listSeasons({ envId: 'plateau', scope: 'all' })
    const kept = after.find((season) => season.id === walk.id)
    // A hand-written description means the operator owns the row, so the seed neither re-labels it
    // nor refreshes its description even though the preset title changed.
    expect(kept?.label).toBe('Season 1: The Walk')
    expect(kept?.description_markdown).toBe('The official fall assignment.')
  })
})
