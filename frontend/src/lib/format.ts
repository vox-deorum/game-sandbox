/**
 * Shared display formatting, deduplicated from the pages (see plans/stage-04.5/page-restructure.md).
 * Pure functions only, no reactivity: anything stateful belongs in a composable, not here.
 */
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'

/** The plus-minus sign (U+00B1), the single glyph joining a mean to its spread in board cells. */
export const PLUS_MINUS = '±'

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

/** A clock time (HH:MM:SS, 24-hour) from an epoch-ms timestamp, for dense log rows in the viewer's locale. */
export function formatLogTime(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(ts))
}

/** A medium date with no time in the viewer's locale, or null for a missing value. */
export function formatDateOnly(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value))
}

/** "player_0" → "Player 0": a human-readable slot label, for attribution. */
export function formatSlot(slot: string): string {
  return slot
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/** "player_0" → "0": the terse slot index for the decision log, whose column header already reads
 *  "Player". Falls back to the whole slot id when it carries no trailing index. */
export function formatSlotIndex(slot: string): string {
  const last = slot.split('_').at(-1)
  return last !== undefined && last !== '' ? last : slot
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

/** A mean score with its spread, as "mean ± sd" (both to two decimals). */
export function formatScoreSpread(mean: number, std: number): string {
  return `${formatScore(mean)} ${PLUS_MINUS} ${formatScore(std)}`
}

/** A weighted-mean agent compute time in milliseconds, or an em dash when no tick contributed. */
export function formatComputeMs(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return '—'
  }
  return `${value.toFixed(1)} ms`
}

/**
 * A mean compute time with its spread, as "mean ± sd ms" (both to one decimal). An em dash when the
 * mean is absent (no tick contributed); just the mean when the spread is somehow absent.
 */
export function formatComputeSpread(
  mean: number | null | undefined,
  std: number | null | undefined,
): string {
  if (mean === null || mean === undefined) {
    return '—'
  }
  if (std === null || std === undefined) {
    return formatComputeMs(mean)
  }
  return `${mean.toFixed(1)} ${PLUS_MINUS} ${std.toFixed(1)} ms`
}

/** A mean human rating, to one decimal (the 1-5 feedback mean). */
export function formatRating(value: number): string {
  return value.toFixed(1)
}

/** A mean rating with its spread, as "mean ± sd" (both to one decimal). */
export function formatRatingSpread(mean: number, std: number): string {
  return `${formatRating(mean)} ${PLUS_MINUS} ${formatRating(std)}`
}

/** A short, human-referenceable id: the leading `n` characters of a generated UUID/text id. */
export function shortId(id: string, n = 8): string {
  return id.slice(0, n)
}

/**
 * A recording id humanized for display: "flappy_bird-<uuid>" → "flappy_bird · 25f548a2", trading the
 * raw key for the environment prefix plus the uuid's first segment. Ids that are not the prefixed-uuid
 * shape (older or test ids) fall back to themselves, so nothing is ever hidden.
 */
export function formatReplayLabel(id: string): string {
  const match = id.match(/^(.*)-([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  return match === null ? id : `${match[1]} · ${match[2]}`
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
