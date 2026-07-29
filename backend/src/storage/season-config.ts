/**
 * The `SeasonConfig` codec: the single validated gate over the `seasons.config` JSON column.
 *
 * The season configuration is a nested, evolving document (a match design plus override blocks),
 * read and written whole by the admin API (step 3) and the scheduler/runner (steps 2/4), never by
 * field. Storing it as one JSON column keeps the schema flat and lets the shape grow without a
 * migration per field; this codec is what keeps the column from ever holding unvalidated text. It is
 * defined once here so the admin API and the scheduler share one definition (and one set of rejection
 * reasons). The codec validates structure only. Seat counts against an environment's metadata are
 * the admin API's job in step 3, not this gate.
 *
 * `deps_version` lives inside the document (not its own column) so a run's frozen `config_snapshot`
 * is the single record of everything that governed the run. The `messaging` override block is a
 * strict shape consumed since Stage 8 (an enabled toggle and a code-point cap); the `llm` block
 * remains inert (validated to be an object and round-tripped unchanged) until Stage 9 gives it a
 * concrete shape.
 */
import { parseSeatSpec, type SeatSpec as SharedSeatSpec } from '@game-sandbox/schema/schedule'
import { z } from 'zod'

import { MAX_LLM_COST_WEIGHT, MODEL_ALIASES } from '../llm/types.js'

/** One seat in a match composition: a named built-in scripted agent, or a participant submission. */
export type SeatSpec = SharedSeatSpec

/**
 * One match configuration: an ordered list of seat specs, the seeds every game in the configuration
 * runs (passed to both env and agents), and the per-configuration game count the scheduler expands.
 * At least one seat and at least one seed are required; `games` is a positive integer.
 */
export const MatchConfigSchema = z.strictObject({
  seats: z
    .array(
      z.string().refine((value): value is SeatSpec => parseSeatSpec(value) !== undefined, {
        message: 'must be submission or builtin:<snake_case>',
      }),
    )
    .min(1),
  seeds: z.array(z.int()).min(1),
  games: z.int().positive(),
})
export type MatchConfig = z.infer<typeof MatchConfigSchema>

/**
 * The season's messaging override, effective since Stage 8. `enabled` can only turn messaging off
 * (the harness combines it with the environment metadata by AND) and `message_cap` can only tighten
 * the cap (combined by minimum). Both are optional; an absent field leaves the environment's own
 * value in force. Unknown keys are rejected.
 */
export const MessagingOverrideSchema = z.strictObject({
  enabled: z.boolean().optional(),
  message_cap: z.int().positive().optional(),
})
export type MessagingOverride = z.infer<typeof MessagingOverrideSchema>

const LlmLimitOverrideSchema = z.strictObject({
  token_budget: z.int().positive().optional(),
  rate_limit_rpm: z.int().positive().optional(),
})

const LlmCostWeightOverrideSchema = z.strictObject({
  large: z.number().positive().finite().max(MAX_LLM_COST_WEIGHT).optional(),
  medium: z.number().positive().finite().max(MAX_LLM_COST_WEIGHT).optional(),
  small: z.number().positive().finite().max(MAX_LLM_COST_WEIGHT).optional(),
})

/** Strict, deployment-independent season overrides for the optional LLM capability. */
export const LlmOverrideSchema = z.strictObject({
  enabled: z.boolean().optional(),
  models: z
    .array(z.enum(MODEL_ALIASES))
    .nonempty()
    .refine((models) => new Set(models).size === models.length, {
      message: 'model aliases must not contain duplicates',
    })
    .optional(),
  cost_weights: LlmCostWeightOverrideSchema.optional(),
  official: LlmLimitOverrideSchema.optional(),
  development: LlmLimitOverrideSchema.optional(),
})
export type LlmOverride = z.infer<typeof LlmOverrideSchema>

/** The storage codec preserves JSON-safe parameter overrides for environment-aware callers. */
export const ParameterOverridesSchema = z.record(
  z.string(),
  z.union([z.boolean(), z.number().finite(), z.string(), z.array(z.string())]),
)
export type ParameterOverrides = z.infer<typeof ParameterOverridesSchema>

/**
 * The optional override block. `step_timeout_ms`/`episode_timeout_ms` are effective this stage (they
 * fall back to the environment defaults when absent). `submission_max_size_mb` overrides the site
 * default cap on a submission's checked-out source size for this season (absent = the site default).
 * `messaging` is a strict shape consumed since Stage 8; `llm` is parsed-but-inert (any object passes,
 * stored untouched) until Stage 9 pins and consumes its shape.
 */
export const OverridesSchema = z.strictObject({
  step_timeout_ms: z.int().positive().optional(),
  episode_timeout_ms: z.int().positive().optional(),
  submission_max_size_mb: z.int().positive().optional(),
  messaging: MessagingOverrideSchema.optional(),
  llm: LlmOverrideSchema.optional(),
  parameters: ParameterOverridesSchema.optional(),
})
export type Overrides = z.infer<typeof OverridesSchema>

/**
 * The whole season configuration. `matches` may be empty while a season is still unconfigured
 * (the workflow trigger, not this codec, refuses to run an empty design). Unknown keys are rejected
 * at every level except inside the still-inert `llm` block.
 */
export const SeasonConfigSchema = z.strictObject({
  deps_version: z.int().positive(),
  matches: z.array(MatchConfigSchema),
  overrides: OverridesSchema.optional(),
})
export type SeasonConfig = z.infer<typeof SeasonConfigSchema>

/** Thrown when a value or stored document does not satisfy {@link SeasonConfigSchema}. */
export class SeasonConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SeasonConfigError'
  }
}

/** A readable one-line summary of the first validation issue, for the typed error message. */
function summarize(error: z.ZodError): string {
  const issue = error.issues[0]
  if (issue === undefined) {
    return 'invalid season config'
  }
  const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
  return `${path}: ${issue.message}`
}

/**
 * Validate an already-parsed value as an {@link SeasonConfig}, throwing {@link SeasonConfigError}
 * on any failure. The admin API can instead call `SeasonConfigSchema.safeParse` directly when it
 * wants to map a specific issue to a 400 reason.
 */
export function parseSeasonConfig(value: unknown): SeasonConfig {
  const result = SeasonConfigSchema.safeParse(value)
  if (!result.success) {
    throw new SeasonConfigError(summarize(result.error))
  }
  return result.data
}

/** Parse the stored JSON text and validate it; used by the storage layer when reading the column. */
export function decodeSeasonConfig(text: string): SeasonConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new SeasonConfigError(
      `season config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return parseSeasonConfig(parsed)
}

/** Validate then serialize to the canonical JSON text the column stores. */
export function encodeSeasonConfig(config: SeasonConfig): string {
  return JSON.stringify(parseSeasonConfig(config))
}

/**
 * The default configuration a freshly declared or seeded season carries: the pinned dependency-set
 * version and an empty match design. The operator fills in `matches` before a run can be triggered.
 */
export function emptySeasonConfig(depsVersion: number): SeasonConfig {
  return { deps_version: depsVersion, matches: [] }
}
