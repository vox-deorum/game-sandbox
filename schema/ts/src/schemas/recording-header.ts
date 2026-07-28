/**
 * The canonical definition of a recording header, which is line 1 of every recording and the first
 * frame of the live stream. Position, not a type field, distinguishes it from state lines.
 *
 * As with the state schema, `schema/recording-header.schema.json` is generated from this module and
 * the Python harness validates against that generated copy.
 */
import { z } from 'zod'

/**
 * One resolved gameplay parameter value. This is the same value domain as `ParameterValue` in
 * `../environment.js`, which stays hand-written because it ships to the browser. The two must agree.
 */
const ParameterValueSchema = z.xor([z.boolean(), z.number(), z.string(), z.array(z.string())])

/**
 * Who or what drove one player. An agent entry carries exactly one identity: a `submission_id` for a
 * participant submission, or a `builtin_name` for a built-in agent. Carrying both or neither is
 * invalid, which is what the three closed variants enforce. A built-in has no owner, so it carries no
 * `user`.
 */
const PlayerAttributionSchema = z.xor([
  z.strictObject({
    kind: z.literal('human'),
    label: z.string().min(1),
    user: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal('agent'),
    label: z.string().min(1),
    user: z.string().optional(),
    submission_id: z
      .string()
      .min(1)
      .meta({ description: 'The submission whose code ran this player.' }),
  }),
  z.strictObject({
    kind: z.literal('agent'),
    label: z.string().min(1),
    builtin_name: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .meta({ description: 'Stable name of the built-in agent whose code ran this player.' }),
  }),
])

/** One auxiliary file stored beside the recording. An unknown name is skipped by the reader. */
const SidecarSchema = z.looseObject({
  name: z.string().meta({
    description:
      "Identifies the sidecar's kind against the registry of known names (empty in Stage 1).",
  }),
  path: z.string().meta({ description: "Path relative to the recording's own directory." }),
})

/**
 * The recording header. The root stays open so a future field can ride along without invalidating
 * existing readers, while every nested shape is closed.
 */
export const RecordingHeaderSchema = z
  .looseObject({
    schema_version: z.literal(1).meta({
      description:
        'Integer schema version. Authoritative for the recording or stream; every state line must match it. Version 1 requires the player attribution, seat partition, and materialized seat plan because pre-release recordings are recreated rather than supported.',
    }),
    environment: z
      .string()
      .meta({ description: 'Name of the environment that produced this recording.' }),
    parameters: z.record(z.string(), ParameterValueSchema).meta({
      description: 'Complete resolved environment parameter map used by this episode.',
    }),
    // The harness writes `datetime.isoformat()`, which carries a `+00:00` offset rather than a `Z`
    // suffix. The format keyword is an annotation here rather than a runtime check, which keeps the
    // generated schema free of a validator-specific regex.
    created_at: z
      .string()
      .optional()
      .meta({ format: 'date-time', description: 'When the recording was created.' }),
    seed: z
      .int()
      .optional()
      .meta({ description: 'Episode seed. Optional now; filled in by Stage 2.' }),
    sidecars: z.array(SidecarSchema).optional().meta({
      description:
        'Auxiliary files stored alongside the recording. A reader that does not recognize a name must skip that entry and load the recording normally.',
    }),
    players: z
      .record(z.string().regex(/^player_[0-9]+$/), PlayerAttributionSchema)
      .refine((players) => Object.keys(players).length > 0, {
        message: 'at least one player attribution is required',
      })
      .meta({
        minProperties: 1,
        description:
          "Per-player attribution: who or what drove each PettingZoo player this episode, keyed by player id (as in a step state's agents map).",
      }),
    // A tuple with a rest element rather than a plain array, so the type carries the non-empty
    // guarantee the seat partition relies on.
    seats: z
      .record(
        z.string().regex(/^seat_[0-9]+$/),
        z
          .tuple([z.string().regex(/^player_[0-9]+$/)], z.string().regex(/^player_[0-9]+$/))
          .meta({ minItems: 1, uniqueItems: true }),
      )
      .refine((seats) => Object.keys(seats).length > 0, {
        message: 'at least one seat is required',
      })
      .meta({
        minProperties: 1,
        description:
          'The resolved seat-to-player map, keyed by seat id. Together with players this is an exact player partition.',
      }),
    seat_plan: z.string().min(1).meta({
      description:
        'Canonical key of the resolved seat plan, or solo for a player-bounds environment.',
    }),
  })
  .meta({
    title: 'RecordingHeader',
    description:
      'Line 1 of every recording and the first frame of the Stage 3 live stream. Position, not a type field, distinguishes it from state lines.',
  })
export type RecordingHeader = z.infer<typeof RecordingHeaderSchema>
