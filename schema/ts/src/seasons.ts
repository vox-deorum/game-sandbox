/**
 * Shared limits for Season guidance authored by operators or agent authors. The backend validates
 * these limits and the frontend mirrors them so both surfaces stay aligned.
 */
export const RATING_PROMPT_MAX = 2_000

/** The public Season description remains one short inline Markdown paragraph. */
export const SEASON_DESCRIPTION_MAX = 2_000

/**
 * Normalize a Season description the way the admin API and the seed both do: collapse CRLF/CR to LF,
 * coalesce Unicode line/paragraph separators and vertical-tab/form-feed to spaces, trim surrounding
 * whitespace, and treat a blank result as null (no description).
 */
export function normalizeSeasonDescription(markdown: string | null): string | null {
  return markdown === null
    ? null
    : markdown
        .replace(/\r\n?/g, '\n')
        .replace(/[\u2028\u2029\v\f]/g, ' ')
        .trim() || null
}

/** The rule a normalized description first violates, in the API's check order. */
export type SeasonDescriptionViolation = 'multiple_paragraphs' | 'too_long'

/**
 * Report whether a normalized description violates the one-paragraph or the length rule. Paragraphs
 * are checked before length, matching the API. Null (no description) never violates.
 */
export function seasonDescriptionViolation(
  normalized: string | null,
): SeasonDescriptionViolation | null {
  if (normalized === null) return null
  if (/\n[ \t]*\n/.test(normalized)) return 'multiple_paragraphs'
  if (normalized.length > SEASON_DESCRIPTION_MAX) return 'too_long'
  return null
}

/** A template repository URL must stay short enough for the local setup command and operator UI. */
export const TEMPLATE_REPO_URL_MAX = 300
