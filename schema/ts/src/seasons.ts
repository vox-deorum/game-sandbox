/**
 * Shared limits for Season guidance authored by operators or agent authors. The backend validates
 * these limits and the frontend mirrors them so both surfaces stay aligned.
 */
export const RATING_PROMPT_MAX = 2_000

/** The public Season description remains one short inline Markdown paragraph. */
export const SEASON_DESCRIPTION_MAX = 2_000

/** A template repository URL must stay short enough for the local setup command and operator UI. */
export const TEMPLATE_REPO_URL_MAX = 300
