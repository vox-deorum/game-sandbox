import {
  type EnvironmentMeta,
  formatParameterValue,
  type ParameterValue,
  visibleParameters,
} from '@game-sandbox/schema/environment'

import type { ResolvedSeasonSettings, SeasonSettings } from '../api/client.js'
import { formatDuration } from './format.js'

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

/**
 * The terminal commands that copy the season template: clone the season's branch into a folder
 * named for the environment and season, enter it, rename the branch to `main`, and remove the
 * template remote. With no remote left, the first push prompts the student's editor to publish
 * the copy to their own GitHub account instead of failing against the template. The per-season
 * folder name keeps copies from different seasons from colliding.
 */
export function setupCommandsFor(meta: EnvironmentMeta, settings: SeasonSettings): string {
  const { branch, url } = settings.template_repo
  const folder = `${meta.env_id}-${settings.season_id}`.replaceAll('_', '-')
  const clone =
    branch === null
      ? `git clone ${url} ${folder}`
      : `git clone -b ${branch} --single-branch ${url} ${folder}`
  return [clone, `cd ${folder}`, 'git branch -M main', 'git remote remove origin'].join('\n')
}
