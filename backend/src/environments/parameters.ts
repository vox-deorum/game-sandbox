/**
 * The one place that turns an environment's parameter declarations plus a season's stored overrides
 * into resolved values.
 *
 * Season overrides are validated against the declarations when an operator writes them, and never
 * again. An environment whose declarations later change (a tightened bound, a renamed parameter, or
 * new player bounds moving the synthesized `players` range) therefore leaves a stored override the
 * current declarations reject. `resolveParameters` already handles that case correctly: a rejected
 * override keeps the environment default, so `values` is always complete and usable. Callers decide
 * what to do with `issue`: an operator write refuses it, a public read serves the values and reports
 * the drift. Keeping that decision in one module is what stops the same stale config from producing
 * four different outcomes across the admin API, the public prefill, and session start.
 */
import {
  type EnvironmentMeta,
  type ParameterIssue,
  type ParameterValue,
  resolveParameters,
} from '@game-sandbox/schema/environment'
import type { Overrides } from '../storage/season-config.js'

/** A season's effective parameter values, plus the first override the environment no longer accepts. */
export interface SeasonParameters {
  /** Complete and valid whether or not `issue` is set; a rejected override keeps its default. */
  values: Record<string, ParameterValue>
  /** Present when the stored config has drifted from the current declarations. */
  issue?: ParameterIssue
}

/** The effective non-parameter rules a season applies to live and workflow sessions. */
export interface SeasonRules {
  step_timeout_ms: number
  episode_timeout_ms: number
  messaging_enabled: boolean
  message_cap: number | null
  llm_enabled: boolean
}

/** Resolved parameter values, drift information, and the rules that govern a session. */
export interface ResolvedSeasonRules extends SeasonParameters {
  rules: SeasonRules
}

/** Resolve a season's parameter overrides against the environment's current declarations. */
export function resolveSeasonParameters(
  meta: EnvironmentMeta,
  overrides: Readonly<Record<string, unknown>> | undefined,
): SeasonParameters {
  const resolved = resolveParameters(meta.parameters, overrides ?? {})
  const issue = resolved.issues[0]
  return issue === undefined ? { values: resolved.values } : { values: resolved.values, issue }
}

/** Resolve every environment and season rule that reaches a launched game. */
export function resolveSeasonRules(
  meta: EnvironmentMeta,
  overrides: Overrides | undefined,
  llmEnabled: boolean,
): ResolvedSeasonRules {
  const parameters = resolveSeasonParameters(meta, overrides?.parameters)
  const caps = [meta.message_cap, overrides?.messaging?.message_cap].filter(
    (cap): cap is number => cap !== null && cap !== undefined,
  )
  return {
    ...parameters,
    rules: {
      step_timeout_ms: overrides?.step_timeout_ms ?? meta.step_limit_ms,
      episode_timeout_ms: overrides?.episode_timeout_ms ?? meta.episode_limit_ms,
      messaging_enabled: meta.messaging && (overrides?.messaging?.enabled ?? true),
      message_cap: caps.length > 0 ? Math.min(...caps) : null,
      llm_enabled: llmEnabled,
    },
  }
}
