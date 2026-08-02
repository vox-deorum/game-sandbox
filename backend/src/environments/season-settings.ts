/**
 * Server-resolved season settings for display-only responses. These are deliberately narrower than
 * the public season-settings endpoint: leaderboard views need the effective values and rules, while
 * template repository details remain specific to setup and submission flows.
 */
import type { ParameterValue } from '@game-sandbox/schema/environment'

import { resolveLlm } from '../llm/config.js'
import { decodeSeasonConfig } from '../storage/index.js'
import type { Season } from '../storage/schema.js'
import { resolveSeasonRules, type SeasonRules } from './parameters.js'
import type { EnvironmentMeta } from './registry.js'

/** The resolved settings a shared season-changes view needs to compare against environment defaults. */
export interface SeasonDisplaySettings {
  values: Record<string, ParameterValue>
  rules: SeasonRules
}

/** Resolve display settings while keeping a stale parameter override from taking the read offline. */
export function resolveSeasonDisplaySettings(
  meta: EnvironmentMeta,
  season: Season,
  llmOptions: Parameters<typeof resolveLlm>[0],
): SeasonDisplaySettings {
  const config = decodeSeasonConfig(season.config)
  const llmEnabled = resolveLlm(llmOptions, meta, config).enabled
  const resolved = resolveSeasonRules(meta, config.overrides, llmEnabled)
  if (resolved.issue !== undefined) {
    // The app is built with `logger: false`, so `request.log` would discard this.
    console.warn(
      `season ${season.id} parameter override ${resolved.issue.name} ${resolved.issue.message}; using the environment default`,
    )
  }
  return { values: resolved.values, rules: resolved.rules }
}
