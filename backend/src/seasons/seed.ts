/**
 * The season seed: what a fresh deployment starts with.
 *
 * Every registered environment keeps one open, unreleased "Playground" season at the current
 * dependency-set version, so submissions have an identity boundary and a pinned `deps_version`. The
 * seed is idempotent: it calls the storage `ensureOpenSeason` primitive per environment, so a
 * restart against an untouched database leaves existing seasons in place.
 *
 * An environment that declares presets additionally receives one hidden template season per preset,
 * each a closed, unreleased season whose label is the preset title, whose config carries the shared
 * `presetOverrides` block (parameter values and, when flagged, LLM enablement), and whose
 * description names the settings it stands up. The Playground season gets a description naming the
 * opening settings when a preset describes those defaults.
 *
 * The seed keys its own rows with the `template_source` provenance marker: `'playground'` for the
 * ensure-open row, or `template:<preset name>` for a template (the namespace stops a preset program
 * id from ever colliding with the Playground marker). Template creates happen only while the
 * environment shows no operator configuration and its arc has not yet been planted, and a present
 * template is re-labeled or re-configured only while it is still exactly what the seed wrote. The
 * Playground description stamp targets the row that carries the `'playground'` marker, never the
 * any open season an operator may have stood up. "Operator configuration" means an operator-made
 * season (null `template_source`), a released season, runs or submissions, match design on any
 * season, or overrides on the Playground row. It is recomputed each boot, so while it holds the
 * seed leaves the environment alone, and an environment that returns to a fresh state can receive
 * the arc again.
 */
import {
  type EnvironmentMeta,
  type EnvPreset,
  formatParameterValue,
  presetOverrides,
  visibleParameters,
} from '@game-sandbox/schema/environment'
import {
  normalizeSeasonDescription,
  seasonDescriptionViolation,
} from '@game-sandbox/schema/seasons'

import type { EnvironmentRegistry } from '../environments/registry.js'
import {
  decodeSeasonConfig,
  type Overrides,
  PLAYGROUND_SOURCE,
  type PublicSeason,
  type SeasonConfig,
  type Storage,
  templateSourceFor,
} from '../storage/index.js'

/** The label a freshly-seeded default season is stood up with. */
export const DEFAULT_SEASON_LABEL = 'Playground'

/**
 * The compiled form of a seed-written description: normalized the way the admin API stores one.
 * Generated text is built from developer-authored metadata the harness already validates, so this
 * asserts rather than repairs: a violation here is a bug that fails the boot loudly, never a
 * silently truncated or rewritten public description.
 */
function compileDescription(text: string): string {
  const normalized = normalizeSeasonDescription(text) ?? ''
  if (seasonDescriptionViolation(normalized) !== null) {
    throw new Error(`generated season description violates the API rules: ${JSON.stringify(text)}`)
  }
  return normalized
}

/**
 * The Playground season's description. A preset with an empty values map and no LLM flag is the
 * environment defaults by construction, exactly what the Playground season already plays, so the
 * claim cannot silently go stale. Null when no preset qualifies.
 */
function playgroundDescription(presets: readonly EnvPreset[]): string | null {
  const preset = presets.find(
    (candidate) => Object.keys(candidate.values).length === 0 && candidate.llm !== true,
  )
  return preset === undefined
    ? null
    : compileDescription(
        `A season for trying things out, playing with the ${preset.title} settings.`,
      )
}

/**
 * One inline-Markdown paragraph naming what a template's preset stands up: the preset title, then
 * every visible value walked in the environment's parameter declaration order and formatted for
 * students, plus the LLM availability when the preset enables it. Hidden parameters (fixed values,
 * single-option choices) never appear, matching the player-facing settings surfaces.
 */
function seedTemplateDescription(meta: EnvironmentMeta, preset: EnvPreset): string {
  const named: string[] = []
  for (const parameter of visibleParameters(meta.parameters)) {
    const value = preset.values[parameter.name]
    if (value === undefined) continue
    named.push(`${parameter.title} ${formatParameterValue(parameter, value)}`)
  }
  const details =
    named.length > 0 ? named.join(', ') : "This season uses the game's default settings"
  const llmSuffix = preset.llm === true ? ' The LLM API is available this season.' : ''
  return compileDescription(`${preset.title}. ${details}.${llmSuffix}`)
}

/**
 * Whether an operator has configured this environment in any way the seed must respect: an
 * operator-made season (null provenance marker), a released season, any runs or submissions, match
 * design on any season, or overrides on the Playground row. Template overrides are the seed's own
 * content, not operator signals. The template-create and description-stamp passes stand down while
 * true. A row whose config cannot be decoded counts as hands-on, so one damaged row never aborts
 * the seed.
 */
export function environmentConfigured(seasons: readonly PublicSeason[]): boolean {
  for (const season of seasons) {
    if (season.template_source === null) return true
    if (season.release_status === 'released') return true
    if (season.submission_count > 0 || season.game_count > 0) return true
    let config: SeasonConfig
    try {
      config = decodeSeasonConfig(season.config)
    } catch {
      return true
    }
    if (config.matches.length > 0) return true
    if (
      season.template_source === PLAYGROUND_SOURCE &&
      config.overrides !== undefined &&
      Object.keys(config.overrides).length > 0
    ) {
      return true
    }
  }
  return false
}

/**
 * Whether a seed template row is still exactly what the seed wrote: both gates closed, unreleased,
 * and still carrying the seed-written description (which names the row's current label). Reconcile
 * actions touch only such rows. An operator who opened a gate or saved their own description owns
 * the row, so the seed leaves it alone even when the preset's title or values have since changed.
 */
function seedStillOwns(season: PublicSeason): boolean {
  return (
    season.template_source !== null &&
    season.submission_status === 'closed' &&
    season.play_status === 'closed' &&
    season.release_status === 'unreleased' &&
    season.description_markdown?.startsWith(`${season.label}.`) === true
  )
}

/** Ensure every environment has its Playground season, plus hidden template seasons per preset. */
export async function seedOpenSeasons(
  storage: Storage,
  environments: EnvironmentRegistry,
  depsVersion: number,
): Promise<void> {
  for (const meta of environments.list()) {
    const presets = meta.presets ?? []
    if (presets.length === 0) {
      // The base invariant: every registered environment keeps one submission-open season, the
      // seed's Playground unless an operator opened another.
      await storage.ensureOpenSeason(meta.env_id, depsVersion, {
        label: DEFAULT_SEASON_LABEL,
      })
      continue
    }

    const seasons = await storage.listSeasons({ envId: meta.env_id, scope: 'all' })
    const configured = environmentConfigured(seasons)
    if (!configured) {
      const planted = await storage.getTemplateArcPlanted(meta.env_id)
      const templatesBySource = new Map(
        seasons
          .filter((season) => season.template_source !== null)
          .map((season) => [season.template_source, season]),
      )
      // The listing is newest first with rowid as the tie-break, so inserting the arc's last preset
      // first and the first preset last makes the display read Playground, then the arc in
      // declaration order: the arc's newest template carries the lowest rowid and sits deepest.
      for (const preset of [...presets].reverse()) {
        const source = templateSourceFor(preset.name)
        const existing = templatesBySource.get(source)
        if (existing === undefined) {
          // Creates happen only while the arc is unplanted: once it is planted, a missing row means
          // an operator deleted it, and the seed respects that until the deployment updates (which
          // clears the marker so the next release's arc is planted).
          if (planted) continue
          await storage.ensureTemplateSeason({
            env_id: meta.env_id,
            deps_version: depsVersion,
            label: preset.title,
            description_markdown: seedTemplateDescription(meta, preset),
            overrides: presetOverrides(preset),
            template_source: source,
          })
        } else if (seedStillOwns(existing)) {
          const previousLabel = existing.label
          const storedConfig = decodeSeasonConfig(existing.config)
          const overrides = presetOverrides(preset) satisfies Overrides | undefined
          const labelChanged = existing.label !== preset.title
          const overridesChanged =
            JSON.stringify(storedConfig.overrides) !== JSON.stringify(overrides)
          if (labelChanged || overridesChanged) {
            if (labelChanged) {
              // The preset's title changed since this template was seeded: re-label rather than
              // duplicate.
              await storage.setSeasonLabel(existing.id, preset.title)
            }
            // The description is refreshed too, but only while it still reads like the seed's own
            // text (it names the previous label); a hand-written description is left alone.
            if (existing.description_markdown?.startsWith(`${previousLabel}.`) === true) {
              await storage.setSeasonDescription(existing.id, seedTemplateDescription(meta, preset))
            }
            if (overridesChanged) {
              await storage.updateSeasonConfig(existing.id, { ...storedConfig, overrides })
            }
          }
        }
      }
      // The arc is now complete for this release cycle. Marking it planted means a later missing
      // row is an operator deletion rather than an unfinished first batch.
      await storage.setTemplateArcPlanted(meta.env_id, true)
    }

    const ensured = await storage.ensureOpenSeason(meta.env_id, depsVersion, {
      label: DEFAULT_SEASON_LABEL,
    })
    // Stamped only while the environment is unconfigured, and only onto the seed's Playground row:
    // ensureOpenSeason can return another season an operator opened, so the description goes to the
    // row that actually carries the Playground marker, and only when its description is still null.
    if (!configured) {
      const description = playgroundDescription(presets)
      if (description !== null) {
        const playground =
          ensured.template_source === PLAYGROUND_SOURCE
            ? ensured
            : seasons.find((season) => season.template_source === PLAYGROUND_SOURCE)
        if (playground !== undefined && playground.description_markdown === null) {
          await storage.setSeasonDescription(playground.id, description)
        }
      }
    }
  }
}
