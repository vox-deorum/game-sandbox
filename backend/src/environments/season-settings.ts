/**
 * Server-resolved season settings for display-only responses. These are deliberately narrower than
 * the public season-settings endpoint: leaderboard views need the effective values and rules, while
 * template repository details remain specific to setup and submission flows.
 */
import { type ResolveLlmOptions, resolveLlm } from '../llm/config.js'
import { decodeSeasonConfig } from '../storage/index.js'
import type { Season } from '../storage/schema.js'
import {
  type ResolvedSeasonRules,
  resolveSeasonRules,
  warnForParameterDrift,
} from './parameters.js'
import type { EnvironmentMeta } from './registry.js'

/** The resolved settings a shared season-changes view needs to compare against environment defaults. */
export type SeasonDisplaySettings = Pick<ResolvedSeasonRules, 'values' | 'rules'>

/** Resolve display settings while keeping a stale parameter override from taking the read offline. */
export function resolveSeasonDisplaySettings(
  meta: EnvironmentMeta,
  season: Season,
  llmOptions: ResolveLlmOptions,
): SeasonDisplaySettings {
  const config = decodeSeasonConfig(season.config)
  const llmEnabled = resolveLlm(llmOptions, meta, config).enabled
  const resolved = resolveSeasonRules(meta, config.overrides, llmEnabled)
  warnForParameterDrift(season.id, resolved)
  return { values: resolved.values, rules: resolved.rules }
}
