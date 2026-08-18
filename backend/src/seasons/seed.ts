/**
 * The season seed: what a fresh deployment starts with.
 *
 * Every registered environment gets one open, unreleased "Playground" season at the current
 * dependency-set version, so submissions have an identity boundary and a pinned `deps_version`.
 * The seed is idempotent: it calls the storage `ensureOpenSeason` primitive per environment, so a
 * restart against an untouched database leaves existing seasons in place, and it stays out of any
 * environment that has been configured (see the template guard below).
 *
 * An environment that declares presets additionally receives one hidden template season per preset,
 * in declaration order. Each template is a closed, unreleased season whose label is the preset title,
 * whose config carries the preset's parameter and (when flagged) LLM overrides, and whose description
 * names the settings it stands up. These templates appear only while the environment is otherwise
 * untouched: if any season beyond the just-ensured Playground row exists, the environment has been
 * configured and the seed stays out of it. The Playground season itself gets a description naming the
 * opening settings when a preset describes those defaults, written only while that description is
 * still unset so an operator's saved text is never replaced.
 */
import {
  type EnvironmentMeta,
  type EnvPreset,
  formatParameterValue,
} from '@game-sandbox/schema/environment'
import type { EnvironmentRegistry } from '../environments/registry.js'
import type { Overrides, Storage } from '../storage/index.js'

/** The label a freshly-seeded default season is stood up with. */
export const DEFAULT_SEASON_LABEL = 'Playground'

/**
 * The override block one preset seeds into its template season: its named parameter values, plus an
 * explicit LLM enablement when the preset asks for it. Omitted entirely when a preset sets neither,
 * so the template season starts with no override layer at all.
 */
function presetOverrides(preset: EnvPreset): Overrides | undefined {
  const overrides: Overrides = {}
  if (Object.keys(preset.values).length > 0) {
    overrides.parameters = { ...preset.values }
  }
  if (preset.llm === true) {
    overrides.llm = { enabled: true }
  }
  return Object.keys(overrides).length === 0 ? undefined : overrides
}

/**
 * The Playground season's description. A preset with an empty values map and no LLM flag is the
 * environment defaults by construction — exactly what the Playground season already plays — so the
 * claim cannot silently go stale. Null when no preset qualifies.
 */
function playgroundDescription(presets: readonly EnvPreset[]): string | null {
  const preset = presets.find(
    (candidate) => Object.keys(candidate.values).length === 0 && candidate.llm !== true,
  )
  return preset === undefined
    ? null
    : `A season for trying things out, playing with the ${preset.title} settings.`
}

/**
 * One inline-Markdown paragraph naming what a template's preset stands up: the preset title, then
 * every named value walked in the environment's parameter declaration order and formatted for
 * students, plus the LLM availability when the preset enables it.
 */
function templateDescription(meta: EnvironmentMeta, preset: EnvPreset): string {
  const named: string[] = []
  for (const parameter of meta.parameters) {
    const value = preset.values[parameter.name]
    if (value === undefined) continue
    named.push(`${parameter.title} ${formatParameterValue(parameter, value)}`)
  }
  const details =
    named.length > 0 ? named.join(', ') : "This season uses the game's default settings"
  const llmSuffix = preset.llm === true ? ' The LLM API is available this season.' : ''
  return `${preset.title}. ${details}.${llmSuffix}`
}

/** Ensure every environment has its Playground season, plus hidden template seasons per preset. */
export async function seedOpenSeasons(
  storage: Storage,
  environments: EnvironmentRegistry,
  depsVersion: number,
): Promise<void> {
  for (const meta of environments.list()) {
    const playground = await storage.ensureOpenSeason(meta.env_id, depsVersion, {
      label: DEFAULT_SEASON_LABEL,
    })
    const presets = meta.presets ?? []
    if (presets.length === 0) continue

    // Templates appear only while nothing else about the environment has been set up: any season
    // whose id differs from the Playground row just ensured means the deployment was configured.
    const seasons = await storage.listSeasons({ envId: meta.env_id, scope: 'all' })
    if (seasons.some((season) => season.id !== playground.id)) continue

    const description = playgroundDescription(presets)
    // Stamped only while the description is still null: a description an operator saved in the
    // meantime is their content, and the seed must not silently replace it. An operator who clears
    // the description entirely and leaves nothing else counts as fresh again.
    if (description !== null && playground.description_markdown === null) {
      await storage.setSeasonDescription(playground.id, description)
    }
    for (const preset of presets) {
      const overrides = presetOverrides(preset)
      await storage.createSeason({
        env_id: meta.env_id,
        deps_version: depsVersion,
        label: preset.title,
        description_markdown: templateDescription(meta, preset),
        ...(overrides !== undefined ? { overrides } : {}),
      })
    }
  }
}
