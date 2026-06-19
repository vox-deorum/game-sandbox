/**
 * The `SeasonConfig` codec: the single validated gate over the `seasons.config` JSON column.
 *
 * The season configuration is a nested, evolving document (a match design plus override blocks),
 * read and written whole by the admin API (step 3) and the scheduler/runner (steps 2/4), never by
 * field. Storing it as one JSON column keeps the schema flat and lets the shape grow without a
 * migration per field; this codec is what keeps the column from ever holding unvalidated text. It is
 * defined once here so the admin API and the scheduler share one definition (and one set of rejection
 * reasons). The codec validates structure only — slot counts against an environment's metadata are
 * the admin API's job in step 3, not this gate.
 *
 * `deps_version` lives inside the document (not its own column) so a run's frozen `config_snapshot`
 * is the single record of everything that governed the run. The inert `messaging` and `llm` override
 * blocks land this stage as opaque objects: validated to be objects and round-tripped unchanged, so
 * the format is stable before Stages 8/9 give them a concrete shape and consume them.
 */
import { z } from 'zod'

/** One seat in a match composition: the built-in scripted baseline, or a participant submission. */
export const SLOT_SPECS = ['builtin-naive', 'submission'] as const
export type SlotSpec = (typeof SLOT_SPECS)[number]

/**
 * One match configuration: an ordered list of seat specs, the seeds every game in the configuration
 * runs (passed to both env and agents), and the per-configuration game count the scheduler expands.
 * At least one slot and at least one seed are required; `games` is a positive integer.
 */
export const MatchConfigSchema = z.strictObject({
  slots: z.array(z.enum(SLOT_SPECS)).min(1),
  seeds: z.array(z.int()).min(1),
  games: z.int().positive(),
})
export type MatchConfig = z.infer<typeof MatchConfigSchema>

/**
 * The optional override block. `step_timeout_ms`/`episode_timeout_ms` are effective this stage (they
 * fall back to the environment defaults when absent). `messaging` and `llm` are parsed-but-inert: any
 * object passes and is stored untouched until Stages 8/9 pin and consume their shape.
 */
export const OverridesSchema = z.strictObject({
  step_timeout_ms: z.int().positive().optional(),
  episode_timeout_ms: z.int().positive().optional(),
  messaging: z.record(z.string(), z.unknown()).optional(),
  llm: z.record(z.string(), z.unknown()).optional(),
})
export type Overrides = z.infer<typeof OverridesSchema>

/**
 * The whole season configuration. `matches` may be empty while a season is still unconfigured
 * (the workflow trigger, not this codec, refuses to run an empty design). Unknown keys are rejected
 * at every level except the inert `messaging`/`llm` blocks.
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
