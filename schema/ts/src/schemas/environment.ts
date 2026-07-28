/**
 * The canonical structural definition of environment metadata: the field-for-field shape of one
 * environment's Python `to_json()`, plus the invariants a well-formed declaration must satisfy.
 *
 * `schema/environment-meta.schema.json` is generated from this module by
 * `scripts/emit-json-schema.ts`, and the Python harness runs it as a conformance check beside
 * `EnvironmentMeta.__post_init__` (`harness/src/game_sandbox_harness/schema.py`). This module owns
 * every structural rule: what shape a builtin agent, a parameter declaration, or a seat layout must
 * have, and how a layout's declared plans relate to the environment's built-in agents and its
 * synthesized reserved parameter.
 *
 * It deliberately does not own parameter resolution against a runtime-supplied value: that stays
 * hand-written in `../environment.ts`, which imports only the *types* declared here (a type import
 * erases at build time) so the browser-facing module stays free of a runtime zod dependency.
 */
import { z } from 'zod'

/** Matches a snake_case identifier: builtin agent, parameter, and seat plan names. */
const SNAKE_CASE = /^[a-z][a-z0-9_]*$/

const NonEmptyString = z.string().min(1)

// -- Built-in agents ------------------------------------------------------------------------------

/** One named built-in agent an environment stages and exposes. */
export const BuiltinAgentSchema = z
  .strictObject({
    name: z.string().regex(SNAKE_CASE),
    label: NonEmptyString,
  })
  .meta({
    id: 'builtin_agent',
    description: 'One named built-in agent an environment stages and exposes.',
  })
export type BuiltinAgent = z.infer<typeof BuiltinAgentSchema>

/**
 * The declared roster as a whole: non-empty, `naive` first (the baseline every environment must
 * stage), and every name unique.
 */
const BuiltinAgentListSchema = z
  .array(BuiltinAgentSchema)
  .min(1)
  .refine((agents) => agents[0]?.name === 'naive', {
    message: 'the first builtin agent must be named naive',
  })
  .refine((agents) => new Set(agents.map((agent) => agent.name)).size === agents.length, {
    message: 'builtin agent names must be unique',
  })

// -- Parameter declarations -------------------------------------------------------------------

/** A friendly label for a string-valued choice. */
export const EnvParameterChoiceSchema = z
  .strictObject({
    value: NonEmptyString,
    label: NonEmptyString,
  })
  .meta({ id: 'env_parameter_choice', description: 'A friendly label for a string-valued choice.' })
export type EnvParameterChoice = z.infer<typeof EnvParameterChoiceSchema>

/** The parameter kinds the harness publishes in environment metadata. */
export const EnvParameterTypeSchema = z.enum([
  'int',
  'float',
  'string',
  'bool',
  'choice',
  'multi_choice',
])
export type EnvParameterType = z.infer<typeof EnvParameterTypeSchema>

/** A non-empty, uniquely-valued list of choices, shared by the `choice` and `multi_choice` variants. */
function choiceListSchema() {
  return z
    .array(EnvParameterChoiceSchema)
    .min(1)
    .refine((choices) => new Set(choices.map((choice) => choice.value)).size === choices.length, {
      message: 'parameter choice values must be unique',
    })
}

/** The `name`/`title`/`description` fields every parameter variant shares. */
const ParameterFields = {
  name: z.string().regex(SNAKE_CASE),
  title: NonEmptyString,
  description: NonEmptyString,
}

const IntParameterSchema = z
  .strictObject({
    ...ParameterFields,
    type: z.literal('int'),
    default: z.int(),
    min: z.int(),
    max: z.int(),
  })
  .refine((parameter) => parameter.min <= parameter.max, {
    message: 'min must be no greater than max',
    path: ['max'],
  })
  .refine((parameter) => parameter.default >= parameter.min && parameter.default <= parameter.max, {
    message: 'default must be between min and max',
    path: ['default'],
  })

const FloatParameterSchema = z
  .strictObject({
    ...ParameterFields,
    type: z.literal('float'),
    default: z.number(),
    min: z.number(),
    max: z.number(),
  })
  .refine((parameter) => parameter.min <= parameter.max, {
    message: 'min must be no greater than max',
    path: ['max'],
  })
  .refine((parameter) => parameter.default >= parameter.min && parameter.default <= parameter.max, {
    message: 'default must be between min and max',
    path: ['default'],
  })

const StringParameterSchema = z.strictObject({
  ...ParameterFields,
  type: z.literal('string'),
  default: z.string(),
})

const BoolParameterSchema = z.strictObject({
  ...ParameterFields,
  type: z.literal('bool'),
  default: z.boolean(),
})

const ChoiceParameterSchema = z
  .strictObject({
    ...ParameterFields,
    type: z.literal('choice'),
    default: z.string(),
    choices: choiceListSchema(),
  })
  .refine((parameter) => parameter.choices.some((choice) => choice.value === parameter.default), {
    message: 'default must be one of the declared choices',
    path: ['default'],
  })

const MultiChoiceParameterSchema = z
  .strictObject({
    ...ParameterFields,
    type: z.literal('multi_choice'),
    default: z.array(z.string()),
    choices: choiceListSchema(),
  })
  .refine((parameter) => new Set(parameter.default).size === parameter.default.length, {
    message: 'default must not contain duplicate choices',
    path: ['default'],
  })
  .refine(
    (parameter) =>
      parameter.default.every((value) =>
        parameter.choices.some((choice) => choice.value === value),
      ),
    { message: 'default must contain only declared choices', path: ['default'] },
  )

/** A typed, player-facing gameplay parameter declared by an environment. */
export const EnvParameterSchema = z
  .discriminatedUnion('type', [
    IntParameterSchema,
    FloatParameterSchema,
    StringParameterSchema,
    BoolParameterSchema,
    ChoiceParameterSchema,
    MultiChoiceParameterSchema,
  ])
  .meta({
    id: 'env_parameter',
    description: 'A typed, player-facing gameplay parameter declared by an environment.',
  })
export type EnvParameter = z.infer<typeof EnvParameterSchema>

// -- Layout -----------------------------------------------------------------------------------

/** A player-count range where every player receives one assignable seat. */
export const PlayerBoundsLayoutSchema = z
  .strictObject({
    kind: z.literal('player_bounds'),
    min: z.int().min(1),
    max: z.int(),
  })
  .refine((layout) => layout.max >= layout.min, {
    message: 'max must be no less than min',
    path: ['max'],
  })
  .meta({
    id: 'player_bounds_layout',
    description: 'A player-count range where every player receives one assignable seat.',
  })
export type PlayerBoundsLayout = z.infer<typeof PlayerBoundsLayoutSchema>

/** One declared seat, its player indexes, and any designated built-in agent. */
export const SeatDeclarationSchema = z
  .strictObject({
    players: z.array(z.int().min(0)).min(1).meta({ uniqueItems: true }),
    restricted_builtin: z.string().optional(),
  })
  .meta({
    id: 'seat_declaration',
    description: 'One declared seat, its player indexes, and any designated built-in agent.',
  })
export type SeatDeclaration = z.infer<typeof SeatDeclarationSchema>

/** One named, complete assignment of PettingZoo players to seats. */
export const SeatPlanSchema = z
  .strictObject({
    key: z.string().regex(SNAKE_CASE),
    title: NonEmptyString,
    seats: z.array(SeatDeclarationSchema).min(1),
  })
  .refine(
    (plan) => plan.seats.filter((seat) => seat.restricted_builtin !== undefined).length <= 1,
    { message: 'a seat plan may restrict at most one seat', path: ['seats'] },
  )
  .refine((plan) => plan.seats.some((seat) => seat.restricted_builtin === undefined), {
    message: 'a seat plan must leave at least one seat unrestricted',
    path: ['seats'],
  })
  .refine(
    (plan) => {
      const sorted = plan.seats.flatMap((seat) => seat.players).sort((a, b) => a - b)
      return sorted.every((player, index) => player === index)
    },
    {
      message: 'seats must partition players from index 0 without gaps or duplicates',
      path: ['seats'],
    },
  )
  .meta({
    id: 'seat_plan',
    description: 'One named, complete assignment of PettingZoo players to seats.',
  })
export type SeatPlan = z.infer<typeof SeatPlanSchema>

/** The ordered layouts an environment may select through `seat_plan`. */
export const SeatPlansLayoutSchema = z
  .strictObject({
    kind: z.literal('seat_plans'),
    plans: z.array(SeatPlanSchema).min(1),
  })
  .refine((layout) => new Set(layout.plans.map((plan) => plan.key)).size === layout.plans.length, {
    message: 'seat plan keys must be unique',
    path: ['plans'],
  })
  .meta({
    id: 'seat_plans_layout',
    description: 'The ordered layouts an environment may select through seat_plan.',
  })
export type SeatPlansLayout = z.infer<typeof SeatPlansLayoutSchema>

/** How one environment organizes its PettingZoo players into playable seats. */
export const EnvironmentLayoutSchema = z
  .discriminatedUnion('kind', [PlayerBoundsLayoutSchema, SeatPlansLayoutSchema])
  .meta({
    id: 'environment_layout',
    description: 'How one environment organizes its PettingZoo players into playable seats.',
  })
export type EnvironmentLayout = z.infer<typeof EnvironmentLayoutSchema>

// -- Environment metadata -----------------------------------------------------------------------

/**
 * Whether a declaration is the reserved parameter the layout synthesizes: `players` matching a
 * player-bounds range, or `seat_plan` matching the declared seat plans in order. Mirrors
 * `_player_count_parameter`/`_seat_plan_parameter` in the Python harness.
 */
function matchesReservedParameter(
  layout: EnvironmentLayout,
  parameter: EnvParameter | undefined,
): boolean {
  if (parameter === undefined) {
    return false
  }
  if (layout.kind === 'player_bounds') {
    return (
      parameter.name === 'players' &&
      parameter.type === 'int' &&
      parameter.default === layout.max &&
      parameter.min === layout.min &&
      parameter.max === layout.max
    )
  }
  return (
    parameter.name === 'seat_plan' &&
    parameter.type === 'choice' &&
    parameter.default === layout.plans[0]?.key &&
    parameter.choices.length === layout.plans.length &&
    parameter.choices.every(
      (choice, index) =>
        choice.value === layout.plans[index]?.key && choice.label === layout.plans[index]?.title,
    )
  )
}

/** The public-facing metadata for one environment, field-for-field the Python `to_json()`. */
export const EnvironmentMetaSchema = z
  .strictObject({
    env_id: z.string(),
    display_name: z.string(),
    description: z.string(),
    builtin_agents: BuiltinAgentListSchema,
    layout: EnvironmentLayoutSchema,
    human_players: z.array(z.string()),
    human_timeout_ms: z.number().nullable(),
    recommended_episode_ticks: z.int(),
    pace_interval_ms: z.number().nullable(),
    step_limit_ms: z.int(),
    episode_limit_ms: z.int(),
    messaging: z.boolean(),
    message_cap: z.number().nullable(),
    llm: z.boolean(),
    renderer: z.string(),
    seat_order_matters: z.boolean(),
    view_interval_ms: z.number().nullable(),
    live_interval_ms: z.number().nullable(),
    parameters: z.array(EnvParameterSchema).min(1),
  })
  .superRefine((meta, ctx) => {
    const names = meta.parameters.map((parameter) => parameter.name)
    if (new Set(names).size !== names.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'parameter names must be unique',
        path: ['parameters'],
      })
    }

    const reserved = meta.parameters[0]
    const ordinaryNames = new Set(meta.parameters.slice(1).map((parameter) => parameter.name))
    if (ordinaryNames.has('players') || ordinaryNames.has('seat_plan')) {
      ctx.addIssue({
        code: 'custom',
        message: 'players and seat_plan are reserved for the synthesized layout parameter',
        path: ['parameters'],
      })
    }
    if (!matchesReservedParameter(meta.layout, reserved)) {
      ctx.addIssue({
        code: 'custom',
        message: 'the first parameter must be the layout-synthesized declaration',
        path: ['parameters', 0],
      })
    }

    if (meta.layout.kind === 'seat_plans') {
      const builtinNames = new Set(meta.builtin_agents.map((agent) => agent.name))
      for (const [planIndex, plan] of meta.layout.plans.entries()) {
        for (const [seatIndex, seat] of plan.seats.entries()) {
          if (seat.restricted_builtin !== undefined && !builtinNames.has(seat.restricted_builtin)) {
            ctx.addIssue({
              code: 'custom',
              message: `restricted_builtin ${JSON.stringify(seat.restricted_builtin)} does not name a declared builtin agent`,
              path: ['layout', 'plans', planIndex, 'seats', seatIndex, 'restricted_builtin'],
            })
          }
        }
      }
    }
  })
  .meta({
    title: 'EnvironmentMeta',
    description:
      'The public-facing metadata for one environment, field-for-field the Python to_json().',
  })
export type EnvironmentMeta = z.infer<typeof EnvironmentMetaSchema>

// -- Structural guards --------------------------------------------------------------------------
//
// These narrow an unknown value the same way the zod schemas above validate one, for callers (the
// backend's generated-JSON loader, this package's own tests) that want a boolean type guard rather
// than a parse result. `../environment.ts` used to define these by hand; they moved here because
// zod is what backs them now, and that module must stay free of a runtime zod dependency.

/** Structural guard for one environment's complete public metadata. */
export function isEnvironmentMeta(value: unknown): value is EnvironmentMeta {
  return EnvironmentMetaSchema.safeParse(value).success
}

/** Structural guard for one named built-in agent. */
export function isBuiltinAgent(value: unknown): value is BuiltinAgent {
  return BuiltinAgentSchema.safeParse(value).success
}

/** Structural guard for one metadata parameter declaration. */
export function isEnvParameter(value: unknown): value is EnvParameter {
  return EnvParameterSchema.safeParse(value).success
}

/** Structural guard for one friendly parameter choice. */
export function isEnvParameterChoice(value: unknown): value is EnvParameterChoice {
  return EnvParameterChoiceSchema.safeParse(value).success
}
