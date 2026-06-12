/**
 * The public-facing environment metadata shape and its validation guard.
 *
 * The metadata registry itself lives in Python and is emitted as a generated JSON artifact the
 * backend reads at startup. This module carries only the wire shape both sides share — the field
 * set of one environment's `to_json()` — plus the structural guard that validates it. The backend
 * keeps the `EnvironmentRegistry` and the generated-JSON loading; the browser uses the same guard
 * to validate the `GET /api/environments` response. Keeping the shape here means there is one
 * declaration of it, not a backend copy and a frontend copy that drift.
 *
 * Like {@link ./protocol}, this module is dependency-free so the browser imports it directly.
 */

/** The public-facing metadata for one environment, field-for-field the Python `to_json()`. */
export interface EnvironmentMeta {
  env_id: string
  display_name: string
  description: string
  min_slots: number
  max_slots: number
  human_slots: string[]
  human_timeout_ms: number | null
  recommended_episode_ticks: number
  pace_interval_ms: number | null
  step_limit_ms: number
  episode_limit_ms: number
  messaging: boolean
  message_cap: number | null
  llm: boolean
  renderer: string
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isIntOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

/** Structural guard for one metadata entry; the backend loader and the browser client share it. */
export function isEnvironmentMeta(value: unknown): value is EnvironmentMeta {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const m = value as Record<string, unknown>
  return (
    typeof m.env_id === 'string' &&
    typeof m.display_name === 'string' &&
    typeof m.description === 'string' &&
    typeof m.min_slots === 'number' &&
    typeof m.max_slots === 'number' &&
    isStringArray(m.human_slots) &&
    isIntOrNull(m.human_timeout_ms) &&
    typeof m.recommended_episode_ticks === 'number' &&
    isIntOrNull(m.pace_interval_ms) &&
    typeof m.step_limit_ms === 'number' &&
    typeof m.episode_limit_ms === 'number' &&
    typeof m.messaging === 'boolean' &&
    isIntOrNull(m.message_cap) &&
    typeof m.llm === 'boolean' &&
    typeof m.renderer === 'string'
  )
}
