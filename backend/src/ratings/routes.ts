/**
 * The participant rating API (Stage 6.6): collecting 1-5 ratings after a session and the agent
 * author's per-season rating prompt. These are participant actions attributed to the resolved
 * Stage 4 identity, never a body-supplied user, so they live in the plain HTTP layer rather than the
 * operator-gated `/api/admin` prefix.
 *
 * The authoritative source of which agents a session involved is the finished recording's header
 * `players` attribution: it names every slot's driver (human, submission, or the built-in Naive
 * baseline), for both submitted and built-in slots. The header entry shape is the recording schema's;
 * this module
 * is the one place it is translated into the `AgentRef` the rest of the stage stores — an `agent`
 * entry with a `submission_id` becomes a `submission` ref (its owner resolved server-side from the
 * submission, never trusted from the header), an `agent` entry without one becomes `builtin-naive`
 * (keyed on the absence of `submission_id`, not the display label), and `human` entries are skipped.
 * A resolved set containing only the built-in baseline is intentionally returned as empty.
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'

import type { UserDirectory } from '../auth/users.js'
import type { AuthUser, RequestIdentity } from '../identity.js'
import type { RecordingsStore } from '../recordings.js'
import type { AgentRef, Season, Session, Storage } from '../storage/index.js'

/** Everything the rating routes need beyond the Fastify instance. */
export interface RatingDeps {
  storage: Storage
  /** The recordings volume, read for the finished session's `players` attribution. */
  recordings: RecordingsStore
  /** The identity seam: `requireUser` for reads, `requireActive` for writes; admins see identities. */
  identity: RequestIdentity
  /** The display-name directory; non-blind display names resolve the owner's name through it. */
  userDirectory: UserDirectory
}

/** The author's per-submission rating prompt is display-only guidance; cap it so it stays a prompt. */
const AUTHOR_PROMPT_MAX = 2_000

/** The agent identity as it arrives on the wire: no `user_id`, which the route resolves server-side. */
const AgentWireSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('submission'), submission_id: z.string().min(1) }),
  z.strictObject({ kind: z.literal('builtin-naive') }),
])
type AgentWire = z.infer<typeof AgentWireSchema>

/** One submitted score: the agent wire form and the 1-5 value (range checked in the handler). */
const RateBodySchema = z.strictObject({
  ratings: z.array(z.strictObject({ agent: AgentWireSchema, score: z.number().int() })).min(1),
})

/** The author-prompt body: a string to set, or null/empty to clear. */
const AuthorPromptBodySchema = z.strictObject({
  prompt: z.string().max(AUTHOR_PROMPT_MAX).nullable().optional(),
})

/** One rateable agent in the session, as returned to the UI. The wire `agent` carries no `user_id`. */
interface RateableAgentView {
  agent: AgentWire
  /** Viewer-appropriate label: anonymous during playable feedback, identified otherwise. */
  display_name: string
  /** True when the caller owns this submitted agent, so the UI shows it without a rating control. */
  is_own: boolean
  /** The agent author's prompt for this season, when set (null for the ownerless Naive baseline). */
  author_prompt: string | null
  /** The caller's current effective rating, or null when they have not rated this agent. */
  your_rating: number | null
}

/** The rating read/write payload: the season's prompt and a per-agent view, read-only when closed. */
interface RatingView {
  session_id: string
  season_id: string
  /** True when the season's play window is closed: existing ratings show, but no new write is taken. */
  read_only: boolean
  /** The operator's season-wide rating prompt, applying to every agent (null when unset). */
  season_prompt: string | null
  agents: RateableAgentView[]
}

/** A resolved rateable agent: its full {@link AgentRef} (owner included) plus the wire form. */
interface RateableAgent {
  ref: AgentRef
  wire: AgentWire
}

/** The session context the rating routes resolve before doing anything: the row, its season, agents. */
interface RatingContext {
  session: Session
  season: Season
  agents: RateableAgent[]
}

/** A typed refusal mapped onto an HTTP status and a stable machine code the client branches on. */
type ContextFailure = { status: number; code: string; error: string }

/** The stable wire key for an agent ref, so a wire agent matches a resolved one deterministically. */
function wireKey(agent: AgentWire): string {
  return agent.kind === 'submission' ? `submission:${agent.submission_id}` : 'builtin-naive'
}

/** Strip a resolved {@link AgentRef} to its wire form (the owner `user_id` never leaves the server). */
function toWire(ref: AgentRef): AgentWire {
  return ref.kind === 'submission'
    ? { kind: 'submission', submission_id: ref.submission_id }
    : { kind: 'builtin-naive' }
}

/**
 * Resolve the session, its season, and the set of rateable agents involved, or a typed refusal.
 * Ordering matters: a null-season session is not rateable at all; a session without a finalized
 * recording cannot have its involved agents read; only then is the play window considered (by the
 * caller, which differs for reads and writes).
 */
async function resolveContext(
  deps: RatingDeps,
  sessionId: string,
): Promise<{ ok: true; context: RatingContext } | { ok: false; failure: ContextFailure }> {
  const session = await deps.storage.getSession(sessionId)
  if (session === undefined) {
    return fail(404, 'no_such_session', 'no such session')
  }
  if (session.season_id === null) {
    return fail(409, 'session_not_rateable', 'this session has no season to rate against')
  }
  const season = await deps.storage.getSeason(session.season_id)
  if (season === undefined) {
    return fail(409, 'session_not_rateable', 'this session has no season to rate against')
  }
  // A finalized recording means the session has ended and written its recording. A still-running
  // session has a header on the volume but is not finished, so the recording check alone is not enough.
  if (
    session.status !== 'ended' ||
    session.recording_id === null ||
    !(await deps.recordings.exists(session.recording_id))
  ) {
    return fail(409, 'session_not_finished', 'this session has no finalized recording yet')
  }
  const agents = await resolveRateableAgents(deps, session)
  return { ok: true, context: { session, season, agents } }
}

function fail(status: number, code: string, error: string): { ok: false; failure: ContextFailure } {
  return { ok: false, failure: { status, code, error } }
}

/**
 * The rateable agents a session involved. The recording header's `players` map is authoritative; when
 * it cannot be read, fall back to the session's submitted-slot links. Submitted-agent owners are
 * always resolved server-side from
 * the submission row, never trusted from the header. Human slots are skipped — humans are not rateable.
 */
async function resolveRateableAgents(deps: RatingDeps, session: Session): Promise<RateableAgent[]> {
  const header =
    session.recording_id === null
      ? undefined
      : await deps.recordings.readHeader(session.recording_id)

  const refs: AgentRef[] = []
  if (header?.players !== undefined) {
    for (const entry of Object.values(header.players)) {
      if (entry.kind === 'human') {
        continue
      }
      if (entry.submission_id !== undefined) {
        const submission = await deps.storage.getSubmission(entry.submission_id)
        if (submission !== undefined) {
          refs.push({
            kind: 'submission',
            submission_id: submission.id,
            user_id: submission.user_id,
          })
        }
        continue
      }
      // An agent slot with no submission is the built-in Naive baseline, keyed on the absence of a
      // submission id — never on the "Naive agent" display label, which is presentation-only.
      refs.push({ kind: 'builtin-naive' })
    }
  } else {
    // No readable header: recover submitted agents from the slot links.
    const links = await deps.storage.listSessionSubmissions(session.id)
    for (const link of links) {
      const submission = await deps.storage.getSubmission(link.submission_id)
      if (submission !== undefined) {
        refs.push({
          kind: 'submission',
          submission_id: submission.id,
          user_id: submission.user_id,
        })
      }
    }
  }

  // De-duplicate by wire key so the same agent across two slots is one rateable entry.
  const seen = new Set<string>()
  const agents: RateableAgent[] = []
  for (const ref of refs) {
    const wire = toWire(ref)
    const key = wireKey(wire)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    agents.push({ ref, wire })
  }
  // A baseline-only watch recording is useful as a replay, but there is no participant agent to give
  // feedback about. Mixed sessions still include the Naive baseline as a normal rateable agent.
  return agents.some((agent) => agent.ref.kind === 'submission') ? agents : []
}

/**
 * Build the rating view returned by both the read and the write: the season's prompt, and per agent
 * its ownership, author prompt, and the caller's current effective rating. `read_only` reflects a
 * closed play window, so the UI can show prior ratings without offering a save control.
 */
async function buildRatingView(
  deps: RatingDeps,
  context: RatingContext,
  caller: AuthUser,
): Promise<RatingView> {
  const { session, season, agents } = context
  // An admin retains submitted-agent identities while a public play window is open; everyone else
  // sees the blind anonymized numbering.
  const blind = season.play_status === 'open' && caller.status !== 'admin'
  const anonymousNumbers = blind
    ? new Map(
        (await deps.storage.listActiveSubmissionsBySeason(season.id, 'ready')).map(
          (submission, index) => [submission.id, index + 1],
        ),
      )
    : new Map<string, number>()
  // Owner display names for the non-blind labels, batched once across the session's agents. Skipped
  // while blind: the anonymized labels never name an owner, so no lookup is needed.
  const names = blind
    ? new Map<string, string>()
    : await deps.userDirectory.namesFor(
        agents.flatMap((agent) => (agent.ref.kind === 'submission' ? [agent.ref.user_id] : [])),
      )
  const agentViews = await Promise.all(
    agents.map(async (agent): Promise<RateableAgentView> => {
      const isOwn = agent.ref.kind === 'submission' && agent.ref.user_id === caller.id
      const [authorPrompt, rating] = await Promise.all([
        resolveAuthorPrompt(deps, season.id, agent.ref),
        isOwn
          ? Promise.resolve(undefined)
          : deps.storage.getRating(season.id, caller.id, agent.ref),
      ])
      return {
        agent: agent.wire,
        display_name: displayName(agent.ref, isOwn, blind, anonymousNumbers, names),
        is_own: isOwn,
        author_prompt: authorPrompt,
        your_rating: rating?.score ?? null,
      }
    }),
  )
  return {
    session_id: session.id,
    season_id: season.id,
    read_only: season.play_status !== 'open',
    season_prompt: emptyToNull(season.rating_prompt),
    agents: agentViews,
  }
}

/** Name one agent without exposing a submission owner during a playable blind-rating round. */
function displayName(
  ref: AgentRef,
  isOwn: boolean,
  blind: boolean,
  anonymousNumbers: ReadonlyMap<string, number>,
  names: ReadonlyMap<string, string>,
): string {
  if (ref.kind === 'builtin-naive') {
    return 'Naive baseline'
  }
  if (!blind) {
    // The owner's display name when the directory has one; the stable id is the visible fallback.
    return `${names.get(ref.user_id) ?? ref.user_id}'s agent`
  }
  if (isOwn) {
    return 'Your agent'
  }
  const number = anonymousNumbers.get(ref.submission_id)
  return number === undefined ? 'Submitted agent' : `Submitted agent ${number}`
}

/** The author's prompt for a submitted agent, resolved by the owner's identity (survives resubmission). */
async function resolveAuthorPrompt(
  deps: RatingDeps,
  seasonId: string,
  ref: AgentRef,
): Promise<string | null> {
  if (ref.kind !== 'submission') {
    return null
  }
  const row = await deps.storage.getAgentRatingPrompt(seasonId, ref.user_id)
  return emptyToNull(row?.prompt ?? null)
}

/** Treat a null, undefined, or blank string as "no prompt", so an empty stored value reads as none. */
function emptyToNull(value: string | null | undefined): string | null {
  return value === null || value === undefined || value === '' ? null : value
}

/** Register participant rating and author-prompt routes outside the operator-only HTTP layer. */
export function registerRatingRoutes(app: FastifyInstance, deps: RatingDeps): void {
  // Read the caller's existing ratings and the two applicable prompts per involved agent, so the
  // post-session UI renders without a second request and pre-fills what the user already rated.
  app.get<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId/ratings',
    async (request, reply) => {
      const user = await deps.identity.requireUser(request, reply)
      if (user === undefined) {
        return
      }
      const resolved = await resolveContext(deps, request.params.sessionId)
      if (!resolved.ok) {
        return sendFailure(reply, resolved.failure)
      }
      return reply.code(200).send(await buildRatingView(deps, resolved.context, user))
    },
  )

  // Submit (or overwrite) ratings for the session's agents. The whole payload is validated before any
  // write, so a mixed valid/invalid request saves nothing.
  app.post<{ Params: { sessionId: string }; Body: unknown }>(
    '/api/sessions/:sessionId/ratings',
    async (request, reply) => {
      const user = await deps.identity.requireActive(request, reply)
      if (user === undefined) {
        return
      }
      const parsed = RateBodySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid ratings payload', code: 'invalid_request' })
      }
      const callerId = user.id
      const resolved = await resolveContext(deps, request.params.sessionId)
      if (!resolved.ok) {
        return sendFailure(reply, resolved.failure)
      }
      const { context } = resolved
      if (context.season.play_status !== 'open') {
        return reply
          .code(409)
          .send({ error: 'the play window for this season is closed', code: 'play_closed' })
      }
      const validated = validatePayload(parsed.data.ratings, context, callerId)
      if (!validated.ok) {
        return reply.code(400).send({ error: validated.error, code: validated.code })
      }
      // Validation passed for every rating; only now write, so nothing partially saves.
      for (const accepted of validated.accepted) {
        await deps.storage.upsertRating({
          season_id: context.season.id,
          env_id: context.season.env_id,
          rater_user_id: callerId,
          agent: accepted,
          score: validated.scores.get(wireKey(toWire(accepted))) ?? 0,
        })
      }
      return reply.code(200).send(await buildRatingView(deps, context, user))
    },
  )

  // The agent author sets or clears their per-season rating prompt while the season's submission
  // window is open. The caller must have an agent (a submission) in the season; the prompt is keyed
  // by the caller's resolved identity.
  app.put<{ Params: { seasonId: string }; Body: unknown }>(
    '/api/seasons/:seasonId/agent-rating-prompt',
    async (request, reply) => {
      const user = await deps.identity.requireActive(request, reply)
      if (user === undefined) {
        return
      }
      const season = await deps.storage.getSeason(request.params.seasonId)
      if (season === undefined) {
        return reply.code(404).send({ error: 'no such season' })
      }
      const parsed = AuthorPromptBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        const tooLong = parsed.error.issues.some(
          (issue) => issue.path[0] === 'prompt' && issue.code === 'too_big',
        )
        return reply.code(400).send({
          error: tooLong ? 'rating prompt too long' : 'invalid rating prompt',
          code: tooLong ? 'author_prompt_too_long' : 'invalid_request',
        })
      }
      // The prompt is editable only while submissions are open; once they close it locks, even if a
      // play window remains open — the "no more revisions after submissions close" lifecycle the
      // submit form presents. Enforced here so a direct API call cannot bypass it after release.
      if (season.submission_status !== 'open') {
        return reply.code(409).send({
          error: 'submissions for this season are closed',
          code: 'submissions_closed',
        })
      }
      const callerId = user.id
      const submission = await deps.storage.findActiveSubmission(season.id, callerId)
      if (submission === undefined) {
        return reply.code(409).send({
          error: 'you have no agent in this season',
          code: 'no_agent_in_season',
        })
      }
      const prompt = emptyToNull(parsed.data.prompt) ?? ''
      await deps.storage.upsertAgentRatingPrompt(season.id, callerId, prompt)
      return reply.code(200).send({ season_id: season.id, prompt: emptyToNull(prompt) })
    },
  )

  // The author reads their own prompt back to prefill the rating-prompt field in the submit form.
  app.get<{ Params: { seasonId: string } }>(
    '/api/seasons/:seasonId/agent-rating-prompt',
    async (request, reply) => {
      const user = await deps.identity.requireUser(request, reply)
      if (user === undefined) {
        return
      }
      const callerId = user.id
      const row = await deps.storage.getAgentRatingPrompt(request.params.seasonId, callerId)
      return reply.code(200).send({
        season_id: request.params.seasonId,
        prompt: emptyToNull(row?.prompt ?? null),
      })
    },
  )
}

/** The outcome of validating the whole rate payload: the resolved refs and scores, or the first error. */
type PayloadValidation =
  | { ok: true; accepted: AgentRef[]; scores: Map<string, number> }
  | { ok: false; code: string; error: string }

/**
 * Validate every submitted rating against the session's involved agents before any write. Rejects an
 * out-of-range score, an agent not in the session, and the caller's own submitted agent (resolved
 * server-side). Returns the resolved refs (carrying the server-resolved owner) and their scores.
 */
function validatePayload(
  ratings: ReadonlyArray<{ agent: AgentWire; score: number }>,
  context: RatingContext,
  callerId: string,
): PayloadValidation {
  const byKey = new Map(context.agents.map((agent) => [wireKey(agent.wire), agent]))
  const accepted: AgentRef[] = []
  const scores = new Map<string, number>()
  for (const rating of ratings) {
    if (!Number.isInteger(rating.score) || rating.score < 1 || rating.score > 5) {
      return { ok: false, code: 'invalid_score', error: 'a score must be an integer from 1 to 5' }
    }
    const key = wireKey(rating.agent)
    const match = byKey.get(key)
    if (match === undefined) {
      return {
        ok: false,
        code: 'agent_not_in_session',
        error: 'that agent did not take part in this session',
      }
    }
    if (match.ref.kind === 'submission' && match.ref.user_id === callerId) {
      return {
        ok: false,
        code: 'own_agent',
        error: 'you cannot rate your own submitted agent',
      }
    }
    accepted.push(match.ref)
    scores.set(key, rating.score)
  }
  return { ok: true, accepted, scores }
}

/** Send a typed context failure as its HTTP status with a stable `code`. */
function sendFailure(reply: FastifyReply, failure: ContextFailure): FastifyReply {
  reply.code(failure.status).send({ error: failure.error, code: failure.code })
  return reply
}
