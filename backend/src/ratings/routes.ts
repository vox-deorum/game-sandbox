/**
 * The participant rating API (Stage 6.6): collecting 1-5 ratings after a session and the agent
 * author's per-season rating prompt. These are participant actions attributed to the resolved
 * Stage 4 identity, never a body-supplied user, so they live in the plain HTTP layer rather than the
 * operator-gated `/api/admin` prefix.
 *
 * The authoritative source of which agents a session involved is the finished recording's header
 * `players` attribution: it names every player's driver (human, submission, or the built-in Naive
 * baseline), for both submitted and built-in players. The header entry shape is the recording schema's;
 * this module
 * is the one place it is translated into the `AgentRef` the rest of the stage stores — an `agent`
 * entry with a `submission_id` becomes a `submission` ref (its owner resolved server-side from the
 * submission, never trusted from the header), an `agent` entry with a `builtin_name` becomes a named
 * built-in ref, and `human` entries are skipped.
 * A resolved set containing only the built-in baseline is intentionally returned as empty.
 */
import { agentRefKey } from '@game-sandbox/schema/board'
import { RATING_FEEDBACK_MAX, RATING_PROMPT_MAX } from '@game-sandbox/schema/seasons'
import { codePointLength } from '@game-sandbox/schema/text'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { AuthUser, RequestIdentity } from '../auth/identity.js'
import type { UserDirectory } from '../auth/users.js'
import type { RecordingsStore } from '../recordings/store.js'
import type { AgentRef, Rating, Season, Session, Storage } from '../storage/index.js'
import { agentKey } from '../storage/kysely/shared.js'
import { optionalField } from '../util/optional-field.js'

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

/** The agent identity as it arrives on the wire: no `user_id`, which the route resolves server-side. */
const AgentWireSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('submission'), submission_id: z.string().min(1) }),
  z.strictObject({ kind: z.literal('builtin'), name: z.string().min(1) }),
])
type AgentWire = z.infer<typeof AgentWireSchema>

/** One submitted score: the agent wire form, the 1-5 value (range checked in the handler), and the
 * required written comment (required-ness and length checked in `validatePayload`). */
const RateBodySchema = z.strictObject({
  ratings: z
    .array(
      z.strictObject({
        agent: AgentWireSchema,
        score: z.number().int(),
        feedback: z.string(),
      }),
    )
    .min(1),
})

/** The author-prompt body: a string to set, or null/empty to clear. */
const AuthorPromptBodySchema = z.strictObject({
  prompt: z.string().max(RATING_PROMPT_MAX).nullable().optional(),
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
  /** The caller's current written comment for this agent, or null when they have not rated it. */
  your_feedback: string | null
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
  /** The recording's launch-time built-in label, absent for submitted agents. */
  builtinLabel?: string
}

/** The session context the rating routes resolve before doing anything: the row, its season, agents. */
interface RatingContext {
  session: Session
  season: Season
  agents: RateableAgent[]
}

/** A typed refusal mapped onto an HTTP status and a stable machine code the client branches on. */
type ContextFailure = { status: number; code: string; error: string }

/** Strip a resolved {@link AgentRef} to its wire form (the owner `user_id` never leaves the server). */
function toWire(ref: AgentRef): AgentWire {
  return ref.kind === 'submission'
    ? { kind: 'submission', submission_id: ref.submission_id }
    : { kind: 'builtin', name: ref.name }
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
 * it cannot be read, fall back to the session's submitted-seat links. Submitted-agent owners are
 * always resolved server-side from
 * the submission row, never trusted from the header. Human players are skipped because humans are not
 * rateable.
 */
async function resolveRateableAgents(deps: RatingDeps, session: Session): Promise<RateableAgent[]> {
  const header =
    session.recording_id === null
      ? undefined
      : await deps.recordings.readHeader(session.recording_id)

  const candidates: Array<
    { kind: 'submission'; id: string } | { kind: 'builtin'; name: string; label: string }
  > = []
  if (header?.players !== undefined) {
    for (const entry of Object.values(header.players)) {
      if (entry.kind === 'human') {
        continue
      }
      if ('submission_id' in entry) {
        candidates.push({ kind: 'submission', id: entry.submission_id })
        continue
      }
      if ('builtin_name' in entry) {
        candidates.push({ kind: 'builtin', name: entry.builtin_name, label: entry.label })
      }
    }
  } else {
    // No readable header: recover submitted agents from the seat links.
    const links = await deps.storage.listSessionSubmissions(session.id)
    for (const link of links) {
      candidates.push({ kind: 'submission', id: link.submission_id })
    }
  }

  const submissions = new Map(
    (
      await deps.storage.getSubmissionsByIds(
        candidates.flatMap((candidate) => (candidate.kind === 'submission' ? [candidate.id] : [])),
      )
    ).map((submission) => [submission.id, submission]),
  )
  const refs: AgentRef[] = []
  for (const candidate of candidates) {
    if (candidate.kind === 'builtin') {
      refs.push({ kind: 'builtin', name: candidate.name })
      continue
    }
    const submission = submissions.get(candidate.id)
    if (submission !== undefined) {
      refs.push({
        kind: 'submission',
        submission_id: submission.id,
        user_id: submission.user_id,
      })
    }
  }

  // De-duplicate by wire key so the same agent across two players is one rateable entry.
  const seen = new Set<string>()
  const agents: RateableAgent[] = []
  for (const ref of refs) {
    const wire = toWire(ref)
    const key = agentRefKey(wire)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    const candidate =
      ref.kind === 'builtin'
        ? candidates.find(
            (entry): entry is { kind: 'builtin'; name: string; label: string } =>
              entry.kind === 'builtin' && entry.name === ref.name,
          )
        : undefined
    agents.push({ ref, wire, ...optionalField('builtinLabel', candidate?.label) })
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
  const [activeSubmissions, names, seasonRatings, seasonPrompts] = await Promise.all([
    blind ? deps.storage.listActiveSubmissionsBySeason(season.id, 'ready') : Promise.resolve([]),
    blind
      ? Promise.resolve(new Map<string, string>())
      : deps.userDirectory.namesFor(
          agents.flatMap((agent) => (agent.ref.kind === 'submission' ? [agent.ref.user_id] : [])),
        ),
    deps.storage.listRatingsByRater(season.id, caller.id),
    deps.storage.listAgentRatingPromptsByUsers(
      season.id,
      agents.flatMap((agent) => (agent.ref.kind === 'submission' ? [agent.ref.user_id] : [])),
    ),
  ])
  const anonymousNumbers = new Map(
    activeSubmissions.map((submission, index) => [submission.id, index + 1]),
  )
  const ratings = new Map(seasonRatings.map((rating) => [agentKey(rating), rating]))
  const prompts = new Map(seasonPrompts.map((prompt) => [prompt.user_id, prompt.prompt]))
  const agentViews = agents.map((agent): RateableAgentView => {
    const isOwn = agent.ref.kind === 'submission' && agent.ref.user_id === caller.id
    const prior = isOwn ? undefined : ratings.get(agentRefKey(agent.wire))
    return {
      agent: agent.wire,
      display_name: displayName(
        agent.ref,
        isOwn,
        blind,
        anonymousNumbers,
        names,
        agent.builtinLabel,
      ),
      is_own: isOwn,
      author_prompt:
        agent.ref.kind === 'submission' ? emptyToNull(prompts.get(agent.ref.user_id)) : null,
      your_rating: prior?.score ?? null,
      your_feedback: prior?.feedback ?? null,
    }
  })
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
  builtinLabel: string | undefined,
): string {
  if (ref.kind === 'builtin') {
    return builtinLabel ?? ref.name
  }
  if (!blind) {
    // The owner's display name when the directory has one; the stable id is the visible fallback.
    return `${names.get(ref.user_id) ?? ref.user_id}'s agent`
  }
  if (isOwn) {
    return 'Your agent'
  }
  const number = anonymousNumbers.get(ref.submission_id)
  return number === undefined ? 'Agent' : `Agent ${number}`
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
        const key = agentRefKey(toWire(accepted))
        await deps.storage.upsertRating({
          season_id: context.season.id,
          env_id: context.season.env_id,
          rater_user_id: callerId,
          agent: accepted,
          score: validated.scores.get(key) ?? 0,
          feedback: validated.feedback.get(key) ?? '',
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

  // The agent author reads the written feedback their agent received, grouped by released season.
  // Gated to the owner themselves (403 otherwise): rater identity never leaves the server, so each
  // row is anonymous. It lives here rather than with the public placements route, which is
  // deliberately unauthenticated. Only released seasons appear, matching the placement-read rule.
  app.get<{ Params: { envId: string; ownerId: string } }>(
    '/api/environments/:envId/agents/:ownerId/feedback',
    async (request, reply) => {
      const user = await deps.identity.requireUser(request, reply)
      if (user === undefined) {
        return
      }
      const { envId, ownerId } = request.params
      if (ownerId !== user.id) {
        return reply.code(403).send({
          error: 'you can read feedback only for your own agent',
          code: 'not_your_agent',
        })
      }
      // The owner's released-season participation is the group set: a season they entered appears even
      // before anyone rated their agent, so the profile can show the "no ratings yet" placeholder.
      const [releasedSeasons, submissions, ratings] = await Promise.all([
        deps.storage.listSeasons({ envId, scope: 'released' }),
        deps.storage.listSubmissionsByUser(ownerId, envId),
        deps.storage.listRatingsForAgentOwner(envId, ownerId),
      ])
      const releasedIds = new Set(releasedSeasons.map((season) => season.id))
      const participatedReleases = releasedSeasons.filter((season) =>
        submissions.some((submission) => submission.season_id === season.id),
      )
      const ratingsBySeason = new Map<string, Rating[]>()
      for (const rating of ratings) {
        if (!releasedIds.has(rating.season_id)) {
          continue
        }
        const rows = ratingsBySeason.get(rating.season_id) ?? []
        rows.push(rating)
        ratingsBySeason.set(rating.season_id, rows)
      }
      const seasons = participatedReleases.map((season) => {
        const rows = ratingsBySeason.get(season.id) ?? []
        const sum = rows.reduce((acc, row) => acc + row.score, 0)
        return {
          season_id: season.id,
          season_label: season.label,
          mean: rows.length === 0 ? 0 : sum / rows.length,
          count: rows.length,
          // `listRatingsForAgentOwner` returns newest first, so the newest comment leads each group.
          ratings: rows.map((rating) => ({
            score: rating.score,
            feedback: rating.feedback,
            rated_at: rating.updated_at,
          })),
        }
      })
      return reply.code(200).send({ env_id: envId, owner_id: ownerId, seasons })
    },
  )
}

/** The outcome of validating the whole rate payload: the resolved refs, scores, and comments, or
 * the first error. The comment is required for every rating (`empty_feedback` when blank after trim)
 * and capped at {@link RATING_FEEDBACK_MAX} code points (`feedback_too_long`). */
type PayloadValidation =
  | { ok: true; accepted: AgentRef[]; scores: Map<string, number>; feedback: Map<string, string> }
  | { ok: false; code: string; error: string }

/**
 * Validate every submitted rating against the session's involved agents before any write. Rejects an
 * out-of-range score, an agent not in the session, the caller's own submitted agent (resolved
 * server-side), and a blank or over-cap comment. Returns the resolved refs (carrying the server-
 * resolved owner), their scores, and their trimmed comments.
 */
function validatePayload(
  ratings: ReadonlyArray<{ agent: AgentWire; score: number; feedback: string }>,
  context: RatingContext,
  callerId: string,
): PayloadValidation {
  const byKey = new Map(context.agents.map((agent) => [agentRefKey(agent.wire), agent]))
  const accepted: AgentRef[] = []
  const scores = new Map<string, number>()
  const feedback = new Map<string, string>()
  for (const rating of ratings) {
    if (!Number.isInteger(rating.score) || rating.score < 1 || rating.score > 5) {
      return { ok: false, code: 'invalid_score', error: 'a score must be an integer from 1 to 5' }
    }
    const key = agentRefKey(rating.agent)
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
    const comment = rating.feedback.trim()
    if (comment === '') {
      return {
        ok: false,
        code: 'empty_feedback',
        error: 'every rating needs a written comment',
      }
    }
    if (codePointLength(comment) > RATING_FEEDBACK_MAX) {
      return {
        ok: false,
        code: 'feedback_too_long',
        error: 'the comment exceeds the length limit',
      }
    }
    accepted.push(match.ref)
    scores.set(key, rating.score)
    feedback.set(key, comment)
  }
  return { ok: true, accepted, scores, feedback }
}

/** Send a typed context failure as its HTTP status with a stable `code`. */
function sendFailure(reply: FastifyReply, failure: ContextFailure): FastifyReply {
  reply.code(failure.status).send({ error: failure.error, code: failure.code })
  return reply
}
