/**
 * Shared display formatting, deduplicated from the pages (see plans/stage-04.5/page-restructure.md).
 * Pure functions only, no reactivity: anything stateful belongs in a composable, not here.
 */
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'

/** A medium date plus short time in the viewer's locale, or null for a missing value. */
export function formatDate(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

/** "1 slot", "2 slots", or "1–4 slots" from an environment's slot range. */
export function slotLabel(meta: EnvironmentMeta): string {
  return meta.min_slots === meta.max_slots
    ? `${meta.min_slots} ${meta.min_slots === 1 ? 'slot' : 'slots'}`
    : `${meta.min_slots}–${meta.max_slots} slots`
}

/** A leaderboard mean score, to two decimals (the normalized higher-is-better number). */
export function formatScore(value: number): string {
  return value.toFixed(2)
}

/** A weighted-mean agent compute time in milliseconds, or an em dash when no tick contributed. */
export function formatComputeMs(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return '—'
  }
  return `${value.toFixed(1)} ms`
}

/** A mean human rating, to one decimal (the 1-5 feedback mean). */
export function formatRating(value: number): string {
  return value.toFixed(1)
}

/**
 * The decision-log cell text for one tick's agent action. The action shape is environment-specific
 * (a scalar like Flappy Bird's 0/1, or a structured object for a richer action space), so this stays
 * generic: a scalar renders as itself, an object as compact `key=value` pairs, and a missing action
 * as an em dash. Semantic naming of an action is the renderer's job, not the host log's.
 */
export function formatAction(action: unknown): string {
  if (action === null || action === undefined) {
    return '—'
  }
  if (typeof action === 'object') {
    const pairs = Object.entries(action as Record<string, unknown>)
    return pairs.length === 0 ? '—' : pairs.map(([k, v]) => `${k}=${String(v)}`).join(' ')
  }
  return String(action)
}
