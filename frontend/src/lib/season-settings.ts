import type { EnvironmentMeta, ParameterValue } from '@game-sandbox/schema/environment'

import type { ResolvedSeasonSettings, SeasonSettings } from '../api/client.js'
import { formatDuration } from './format.js'
import { formatParameterValue, visibleParameters } from './parameters.js'

export interface SeasonChange {
  label: string
  from: string
  to: string
}

function sameValue(left: ParameterValue, right: ParameterValue): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    )
  }
  return left === right
}

function formattedParameters(
  meta: EnvironmentMeta,
  settings: ResolvedSeasonSettings,
): SeasonChange[] {
  return visibleParameters(meta.parameters).flatMap((parameter) => {
    const value = settings.values[parameter.name] ?? parameter.default
    if (sameValue(value, parameter.default)) {
      return []
    }
    return [
      {
        label: parameter.title,
        from: formatParameterValue(parameter, parameter.default),
        to: formatParameterValue(parameter, value),
      },
    ]
  })
}

/** The effective season values that differ from the environment's ordinary defaults. */
export function describeSeasonChanges(
  meta: EnvironmentMeta,
  settings: ResolvedSeasonSettings,
): SeasonChange[] {
  const changes = formattedParameters(meta, settings)
  if (settings.rules.step_timeout_ms !== meta.step_limit_ms) {
    changes.push({
      label: 'Decision limit',
      from: formatDuration(meta.step_limit_ms),
      to: formatDuration(settings.rules.step_timeout_ms),
    })
  }
  if (settings.rules.episode_timeout_ms !== meta.episode_limit_ms) {
    changes.push({
      label: 'Game limit',
      from: formatDuration(meta.episode_limit_ms),
      to: formatDuration(settings.rules.episode_timeout_ms),
    })
  }
  if (meta.messaging && !settings.rules.messaging_enabled) {
    changes.push({
      label: 'Messaging',
      from: 'On',
      to: 'Off',
    })
  }
  if (meta.messaging && settings.rules.message_cap !== meta.message_cap) {
    changes.push({
      label: 'Message length',
      from: meta.message_cap === null ? 'Unlimited' : String(meta.message_cap),
      to: settings.rules.message_cap === null ? 'Unlimited' : String(settings.rules.message_cap),
    })
  }
  if (meta.llm && settings.rules.llm_enabled) {
    changes.push({
      label: 'LLM API',
      from: 'Off',
      to: 'On',
    })
  }
  return changes
}

/**
 * The optional file participants can keep beside a cloned template. It records only reproducible
 * differences, leaving capabilities that are not part of local execution out of the file.
 */
export function seasonSettingsFile(
  meta: EnvironmentMeta,
  settings: SeasonSettings,
): Record<string, unknown> | null {
  const parameters: Record<string, ParameterValue> = {}
  for (const parameter of meta.parameters) {
    const value = settings.values[parameter.name] ?? parameter.default
    if (!sameValue(value, parameter.default)) {
      parameters[parameter.name] = value
    }
  }
  const file: Record<string, unknown> = {
    env_id: meta.env_id,
    season: settings.season_label?.trim() || settings.season_id,
  }
  if (Object.keys(parameters).length > 0) file.parameters = parameters
  if (settings.rules.step_timeout_ms !== meta.step_limit_ms) {
    file.decision_limit_ms = settings.rules.step_timeout_ms
  }
  if (settings.rules.episode_timeout_ms !== meta.episode_limit_ms) {
    file.game_limit_ms = settings.rules.episode_timeout_ms
  }
  return Object.keys(file).length === 2 ? null : file
}

/** A command that preserves the season-selected template branch. */
export function cloneCommandFor(settings: SeasonSettings): string {
  const { branch, url } = settings.template_repo
  return branch === null ? `git clone ${url}` : `git clone -b ${branch} ${url}`
}
