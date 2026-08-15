/**
 * The canonical definition of one per-step state object.
 *
 * These zod schemas are the source of truth for the state contract. `schema/step-state.schema.json`
 * is generated from them by `scripts/emit-json-schema.ts`, and the Python harness validates against
 * that generated copy. Editing this file and regenerating is how the contract changes; the JSON is an
 * output, not an input.
 *
 * The module imports zod, so it is Node-only. The browser reaches these shapes as types alone through
 * the barrel, which erases at build time. See `schema/ts/src/index.ts`.
 */
import { z } from 'zod'

/**
 * Per-agent step data. `observation` and `action` are environment-specific and deliberately
 * unconstrained: the renderer is the only consumer of the first and the replay log of the second.
 */
export const AgentStepSchema = z
  .strictObject({
    observation: z.unknown().optional().meta({
      description:
        'Display observation for this agent. Shape is environment-specific; the renderer is its only consumer.',
    }),
    action: z.unknown().optional().meta({
      description: 'Action this agent took on this tick. Shape is environment-specific.',
    }),
    reward: z.number().meta({ description: 'Reward for this agent on this tick.' }),
    score: z.number().meta({ description: 'Cumulative score for this agent through this tick.' }),
    // Kept inline rather than named, because it is a different shape from the episode-level
    // `step_timing` below: these are the chargeable participant hooks, split so a consumer can show
    // act time on its own.
    timing: z
      .strictObject({
        decision_ms: z.number().min(0).optional().meta({
          description:
            'Chargeable act time for this tick. The leaderboard compute column combines it with optional-hook timing.',
        }),
        learn_ms: z.number().min(0).optional().meta({
          description:
            'Chargeable optional-learn time for this tick. Present only for learning agents and kept separate so consumers can show act time alone.',
        }),
        chat_ms: z.number().min(0).optional().meta({
          description:
            'Chargeable optional-chat time for this tick. Present only when the chat hook runs and kept separate so consumers can show act time alone.',
        }),
      })
      .optional(),
  })
  .meta({ id: 'agent_step' })
export type AgentStep = z.infer<typeof AgentStepSchema>

/** One message sent on a tick. A null recipient is a broadcast. */
export const MessageSchema = z
  .strictObject({
    from: z.string().meta({ description: 'Player id of the sender.' }),
    to: z
      .string()
      .nullable()
      .meta({ description: 'Player id of the recipient, or null for a broadcast.' }),
    text: z.string(),
    recipients: z.array(z.string()).optional().meta({
      description:
        'Live-stream-only delivered audience of a broadcast the environment bounded. The backend uses it to filter a controller view and strips it before any browser; a recording never contains it.',
    }),
  })
  .meta({ id: 'message' })
export type Message = z.infer<typeof MessageSchema>

/** The external player's allowed direct recipients and default recipient for the current state. */
export const ChatOptionsSchema = z
  .strictObject({
    sender: z
      .string()
      .meta({ description: 'Player id of the external actor allowed to send on this state.' }),
    target_recipients: z
      .array(z.string())
      .refine((recipients) => new Set(recipients).size === recipients.length, {
        message: 'direct-message recipients must be unique',
      })
      .meta({
        uniqueItems: true,
        description: 'Ordered direct-message recipients. Broadcast is always available separately.',
      }),
    default_recipient: z.string().nullable().meta({
      description: 'The selected direct recipient, or null when broadcast is the default.',
    }),
  })
  .meta({
    id: 'chat_options',
    description:
      "The current external player's allowed direct recipients and default recipient. Absent when no external messaging turn is open.",
  })
export type ChatOptions = z.infer<typeof ChatOptionsSchema>

/** Wall-clock timing for the whole step, distinct from an agent's chargeable hook timing. */
export const StepTimingSchema = z
  .strictObject({
    started_at: z.int().meta({ description: 'epoch milliseconds UTC' }),
    duration_ms: z.number().min(0).meta({ description: 'Wall-clock duration of the whole step.' }),
  })
  .meta({ id: 'step_timing' })
export type StepTiming = z.infer<typeof StepTimingSchema>

/**
 * One per-step state object: the wire format between the environment and the renderer, and the
 * per-line payload stored in a recording. `overlay` is the one open region; everything else is closed
 * so an unrecognized field fails loudly rather than riding along unnoticed.
 */
export const StepStateSchema = z
  .strictObject({
    schema_version: z.literal(1).meta({
      description:
        "Integer schema version. Bumps only on breaking changes; equal to the recording header's schema_version.",
    }),
    tick: z
      .int()
      .min(0)
      .meta({ description: 'Monotonic step counter for the episode, starting at 0.' }),
    agents: z.record(z.string(), AgentStepSchema).meta({
      description: 'Per-agent step data keyed by player id (the PettingZoo agent id).',
    }),
    overlay: z.record(z.string(), z.unknown()).optional().meta({
      description:
        'Open extension region for environment-specific payloads (for example Flappy Bird pipe positions). The only object with additionalProperties allowed.',
    }),
    messages: z.array(MessageSchema).optional().meta({
      description:
        'Messages sent on this tick. Absent when empty to keep lines small. Lit up in Stage 8.',
    }),
    chat_options: ChatOptionsSchema.optional(),
    timing: StepTimingSchema,
  })
  .meta({
    title: 'StepState',
    description:
      'One per-step state object: the canonical wire format between the environment and the renderer, and the per-line payload stored in a recording.',
  })
export type StepState = z.infer<typeof StepStateSchema>
