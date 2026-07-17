/**
 * The stable public LLM model aliases agent code and season configs may name. The single source for
 * the backend (season codec, proxy grants) and the frontend (season editor, API client types): a new
 * tier is added here once and every alias list follows.
 */
export const MODEL_ALIASES = ['large', 'medium', 'small'] as const
export type ModelAlias = (typeof MODEL_ALIASES)[number]
