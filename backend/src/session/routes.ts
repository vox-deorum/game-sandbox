/**
 * HTTP and WebSocket routes for creating, reading, stopping, and attaching to live sessions.
 */
import type { ParameterValue } from '@game-sandbox/schema/environment'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'

import type { RequestIdentity } from '../auth/identity.js'
import type { UserDirectory } from '../auth/users.js'
import { optionalField } from '../util/optional-field.js'
import { zodReason } from '../util/zod-error.js'
import type { ClientSocket } from './live-session.js'
import { type Orchestrator, OrchestratorError, type SeatAssignment } from './orchestrator.js'

export interface SessionRouteDeps {
  orchestrator: Orchestrator
  identity: RequestIdentity
  userDirectory: UserDirectory
}

/** A seat filled by a named built-in bot, or by a participant's named submission. */
const BuiltinAgentSeatSchema = z.strictObject({
  kind: z.literal('builtin-agent'),
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
})
const SubmissionAgentSeatSchema = z.strictObject({
  kind: z.literal('submission'),
  submission_id: z.string().min(1),
})

/** The two-way agent union a human seat's optional companion carries (a future wide seat). */
const AgentSeatAssignmentSchema = z.discriminatedUnion('kind', [
  BuiltinAgentSeatSchema,
  SubmissionAgentSeatSchema,
])
type AgentSeatAssignmentBody = z.infer<typeof AgentSeatAssignmentSchema>

/**
 * One seat assignment on the wire: a three-way union on `kind`, plus the optional companion a
 * `human` seat may carry. `submission_id` is required exactly for a `submission` seat and `name`
 * exactly for a `builtin-agent` seat; neither field, nor a `companion`, is accepted anywhere else.
 */
const SeatAssignmentSchema = z.discriminatedUnion('kind', [
  BuiltinAgentSeatSchema,
  SubmissionAgentSeatSchema,
  z.strictObject({ kind: z.literal('human'), companion: AgentSeatAssignmentSchema.optional() }),
])
type SeatAssignmentBody = z.infer<typeof SeatAssignmentSchema>

/**
 * Body for POST /api/sessions: an explicit per-seat assignment keyed by seat id, each value naming
 * what fills the seat (human, built-in Naive, or a named submission). The orchestrator derives the
 * mode and validates the composition.
 */
const StartSessionBodySchema = z.strictObject({
  env_id: z.string().min(1),
  season_id: z.string().min(1),
  seed: z.int().nonnegative().optional(),
  human_timeout_ms: z.int().nonnegative().optional(),
  // Only the shape is checked here. Which values a parameter accepts is the environment's own
  // contract: the orchestrator resolves this map against the live declarations and answers with a
  // typed `invalid_parameters` reason when a value is out of bounds or the wrong type. Restating
  // those value types here would duplicate that contract in a weaker, easily-drifting form.
  parameters: z.record(z.string(), z.unknown()),
  seats: z
    .record(z.string().regex(/^seat_[0-9]+$/), SeatAssignmentSchema)
    .refine((seats) => Object.keys(seats).length > 0, { message: 'at least one seat is required' }),
})
type StartBody = z.infer<typeof StartSessionBodySchema>

/** Map one ordinary wire agent assignment onto the orchestrator shape. */
function toAgentSeatAssignment(
  body: AgentSeatAssignmentBody,
): Exclude<SeatAssignment, { kind: 'human' }> {
  if (body.kind === 'submission') {
    return { kind: 'submission', submissionId: body.submission_id }
  }
  return { kind: body.kind, name: body.name }
}

/** Map a wire seat assignment onto the orchestrator's discriminated union. */
function toSeatAssignment(body: SeatAssignmentBody): SeatAssignment {
  if (body.kind !== 'human') {
    return toAgentSeatAssignment(body)
  }
  return body.companion === undefined
    ? { kind: 'human' }
    : { kind: 'human', companion: toAgentSeatAssignment(body.companion) }
}

/** Register the session HTTP and WebSocket routes. */
export function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): void {
  const { identity } = deps

  app.post<{ Body: unknown }>('/api/sessions', async (request, reply) => {
    const user = await identity.requireActive(request, reply)
    if (user === undefined) {
      return
    }
    const parsed = StartSessionBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid session request',
        code: 'invalid_request',
        reason: zodReason(parsed.error),
      })
    }
    const body: StartBody = parsed.data
    try {
      const result = await deps.orchestrator.start({
        userId: user.id,
        envId: body.env_id,
        seasonId: body.season_id,
        seed: body.seed,
        humanTimeoutMs: body.human_timeout_ms,
        // `parameters` stays opaque at the wire boundary (see the schema above); the orchestrator is
        // the one place that gives it a typed shape, against the environment's live declarations.
        parameters: body.parameters as Record<string, ParameterValue>,
        seats: Object.fromEntries(
          Object.entries(body.seats).map(([seatId, assignment]) => [
            seatId,
            toSeatAssignment(assignment),
          ]),
        ),
      })
      return reply.code(201).send({ id: result.id, ws_path: result.wsPath })
    } catch (error) {
      return replyError(reply, error)
    }
  })

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    const session = await deps.orchestrator.getSession(request.params.id)
    if (session === undefined) {
      return reply.code(404).send({ error: 'no such session' })
    }
    // The owner's display name beside the stable id, resolved at read time (omitted when unknown).
    const names = await deps.userDirectory.namesFor([session.user_id])
    return { ...session, ...optionalField('user_name', names.get(session.user_id)) }
  })

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    const user = await identity.requireActive(request, reply)
    if (user === undefined) {
      return
    }
    try {
      await deps.orchestrator.stop(request.params.id, user.id)
      return reply.code(204).send()
    } catch (error) {
      return replyError(reply, error)
    }
  })

  app.get<{ Params: { id: string } }>(
    '/api/sessions/:id/ws',
    { websocket: true },
    async (socket, request) => {
      // The session cookie rides the WebSocket upgrade on the same origin, so spectating is public and
      // ownership is decided by the resolved user. An anonymous socket attaches with a null user and
      // can never be the owner or hold the human seat.
      const user = await identity.resolveUser(request)
      const client: ClientSocket = {
        send: (data) => socket.send(data),
        close: () => socket.close(),
        get bufferedAmount() {
          return socket.bufferedAmount
        },
      }
      const attachment = deps.orchestrator.attach(request.params.id, client, user?.id ?? null)
      if (attachment === undefined) {
        socket.close(1008, 'no such session')
        return
      }
      socket.on('message', (data: Buffer) => attachment.handleMessage(data.toString()))
      socket.on('close', () => attachment.detach())
    },
  )
}

function replyError(reply: FastifyReply, error: unknown): unknown {
  if (error instanceof OrchestratorError) {
    // The body carries a stable `code` the frontend branches on, plus any details (the active
    // session id) merged in so the 409 rejoin path has somewhere to read it.
    return reply
      .code(error.status)
      .send({ error: error.message, code: error.code, ...error.details })
  }
  throw error
}
