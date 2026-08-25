/**
 * The participant submission API: source admission, validation-job enqueueing, owner history, and
 * public watch choices. The worker owns validation and image building; these routes only create or
 * read storage rows and return the current state.
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'

import { namesVisible, type RequestIdentity } from '../auth/identity.js'
import type { UserDirectory } from '../auth/users.js'
import { type Storage, SubmissionConflictError } from '../storage/index.js'
import { optionalField } from '../util/optional-field.js'
import { zodReason } from '../util/zod-error.js'
import type { SourceInput, SubmissionSource } from './source/index.js'
import { unsafeGitUrlReason } from './source/index.js'
import type { SubmissionEnqueuer } from './worker.js'

/** Everything the public submission routes need. */
export interface SubmissionRouteDeps {
  storage: Storage
  submissionSource: SubmissionSource
  validationWorker: SubmissionEnqueuer
  allowLocalSubmissions: boolean
  identity: RequestIdentity
  userDirectory: UserDirectory
}

/**
 * A repository URL that passes the source seam's structural admission: bare http(s), no embedded
 * credentials, and no query or fragment. Rejected at the wire so credentials pasted into a URL are
 * never persisted to a submission row (which the public agent profile serves back verbatim) or
 * handed to git. The DNS/private-address layer still runs later in the source seam.
 */
const RepoUrlSchema = z
  .string()
  .refine((url) => unsafeGitUrlReason(url) === null, 'repository URL is not acceptable')
  .optional()

/** The source fields shared by the reachability pre-check and the submit body. */
const SOURCE_PROPERTIES = {
  repo_url: RepoUrlSchema,
  ref: z.string().nullable().optional(),
  local_path: z.string().optional(),
}

/** Body for POST /api/submissions/reachability. */
const ReachabilityBodySchema = z.strictObject(SOURCE_PROPERTIES)

/** A participant's source as it arrives on the wire: a git repo (+ optional ref) or a local folder. */
type SourceBody = z.infer<typeof ReachabilityBodySchema>

/** Body for POST /api/submissions; the source is validated in the handler. */
const SubmitBodySchema = z.strictObject({
  env_id: z.string().min(1),
  ...SOURCE_PROPERTIES,
})
type SubmitBody = z.infer<typeof SubmitBodySchema>

/** How many recent recordings the agent profile lists per submission; older runs stay queryable. */
const PROFILE_REPLAY_LIMIT = 10

/**
 * Map a wire source body onto the seam's {@link SourceInput}: a non-empty `local_path` is a local
 * source, otherwise a non-empty `repo_url` is a git source, otherwise null (neither was supplied).
 */
function sourceInputFromBody(body: SourceBody): SourceInput | null {
  if (typeof body.local_path === 'string' && body.local_path !== '') {
    return { kind: 'local', localPath: body.local_path }
  }
  if (typeof body.repo_url === 'string' && body.repo_url !== '') {
    return { kind: 'git', repoUrl: body.repo_url, ref: body.ref ?? null }
  }
  return null
}

/**
 * Apply the submission-source admission policy shared by reachability and submit. Local paths keep
 * precedence over repo URLs, and the local-development gate is checked before either route performs
 * any source or season work. Returns `undefined` after sending the existing typed refusal.
 */
function admitSubmissionSource(
  body: SourceBody,
  allowLocalSubmissions: boolean,
  reply: FastifyReply,
): SourceInput | undefined {
  const input = sourceInputFromBody(body)
  if (input === null) {
    reply.code(400).send({ error: 'a repo_url or local_path is required', code: 'invalid_source' })
    return undefined
  }
  if (input.kind === 'local' && !allowLocalSubmissions) {
    reply.code(403).send({ error: 'local submissions are disabled', code: 'local_disabled' })
    return undefined
  }
  return input
}

/** Register the public submission, watch-agent, and agent-profile routes. */
export function registerSubmissionRoutes(app: FastifyInstance, deps: SubmissionRouteDeps): void {
  // The capabilities probe: the form mirrors the backend's dev gate so the local-folder field is
  // driven by both `import.meta.env.DEV` and this flag, never by the frontend build alone.
  app.get('/api/submissions/capabilities', () => ({
    local_submissions: deps.allowLocalSubmissions,
  }))

  // The cheap pre-accept reachability check: verify the repo (and ref) before a row is written, the
  // explicit frontend requirement. A local source is refused here when the dev gate is off, before
  // the source seam is touched, matching step 2's gating.
  app.post<{ Body: unknown }>('/api/submissions/reachability', async (request, reply) => {
    const user = await deps.identity.requireActive(request, reply)
    if (user === undefined) {
      return
    }
    const parsed = ReachabilityBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid reachability request',
        code: 'invalid_request',
        reason: zodReason(parsed.error),
      })
    }
    const input = admitSubmissionSource(parsed.data, deps.allowLocalSubmissions, reply)
    if (input === undefined) {
      return
    }
    return reply.code(200).send(await deps.submissionSource.verifyReachable(input))
  })

  // Submit: resolve the open season, create the pending row under the resolved identity, enqueue
  // the validate-and-build job, and return 202. The pipeline never runs inline. The submitter is
  // never read from the client. Resubmission supersedes the prior active row inside createSubmission.
  app.post<{ Body: unknown }>('/api/submissions', async (request, reply) => {
    const user = await deps.identity.requireActive(request, reply)
    if (user === undefined) {
      return
    }
    const parsed = SubmitBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid submission request',
        code: 'invalid_request',
        reason: zodReason(parsed.error),
      })
    }
    const body: SubmitBody = parsed.data
    const input = admitSubmissionSource(body, deps.allowLocalSubmissions, reply)
    if (input === undefined) {
      return
    }
    const season = await deps.storage.getOpenSubmissionSeason(body.env_id)
    if (season === undefined) {
      return reply
        .code(409)
        .send({ error: 'submissions are closed for this environment', code: 'no_open_season' })
    }
    try {
      const submission = await deps.storage.createSubmission({
        season_id: season.id,
        env_id: body.env_id,
        user_id: user.id,
        source_kind: input.kind,
        repo_url: input.kind === 'git' ? input.repoUrl : null,
        commit_sha: null,
        local_path: input.kind === 'local' ? input.localPath : null,
        ref: input.kind === 'git' ? input.ref : null,
        created_at: new Date().toISOString(),
      })
      deps.validationWorker.enqueue(submission.id)
      return reply.code(202).send({ id: submission.id, status: submission.status })
    } catch (error) {
      if (error instanceof SubmissionConflictError) {
        // A concurrent resubmit became active; the client may retry.
        return reply.code(409).send({ error: error.message, code: 'resubmit_conflict' })
      }
      throw error
    }
  })

  // The current user's submissions (including superseded history), newest first, optionally one
  // environment. The agent profile reads this; the form reads the single submission below.
  app.get<{ Querystring: { env?: string } }>('/api/submissions', async (request, reply) => {
    const user = await deps.identity.requireUser(request, reply)
    if (user === undefined) {
      return
    }
    return deps.storage.listSubmissionsByUser(user.id, request.query.env)
  })

  // One submission joined with its ordered per-stage validation log, so a poll is a single request.
  // Submission ids appear in the anonymous watch-list contract, so this route must not turn one of
  // those ids back into an owner/source lookup for an ordinary viewer.
  app.get<{ Params: { id: string } }>('/api/submissions/:id', async (request, reply) => {
    const user = await deps.identity.requireUser(request, reply)
    if (user === undefined) {
      return
    }
    const submission = await deps.storage.getSubmission(request.params.id)
    if (submission === undefined) {
      return reply.code(404).send({ error: 'no such submission' })
    }
    if (submission.user_id !== user.id && user.status !== 'admin') {
      return reply.code(403).send({ error: 'submission access denied', code: 'forbidden' })
    }
    const checks = await deps.storage.listSubmissionChecks(submission.id)
    return { ...submission, checks }
  })

  // Viewer-specific watch choices for the play-open season. Public, but personalized only when a user
  // resolves: an anonymous caller gets the unpersonalized sequence with no rating status and no
  // operator extras; a signed-in viewer receives their rating state; an admin additionally receives
  // owner/source details. The submission window may point at another round, so it never drives this list.
  app.get<{ Params: { envId: string } }>(
    '/api/environments/:envId/watch-agents',
    async (request) => {
      const season = await deps.storage.getPublicPlaySeason(request.params.envId)
      if (season === undefined) {
        return []
      }
      const user = await deps.identity.resolveUser(request)
      const operator = user?.status === 'admin'
      const submissions = await deps.storage.listActiveSubmissionsBySeason(season.id, 'ready')
      // Owner display names ride only in the operator extras; batch them once across the listing.
      const ownerNames = operator
        ? await deps.userDirectory.namesFor(submissions.map((submission) => submission.user_id))
        : new Map<string, string>()
      const viewerRatings =
        user === null
          ? new Set<string>()
          : new Set(
              (await deps.storage.listRatingsByRater(season.id, user.id))
                .filter((rating) => rating.agent_kind === 'submission')
                .flatMap((rating) =>
                  rating.agent_submission_id === null ? [] : [rating.agent_submission_id],
                ),
            )
      return submissions.map((submission, index) => {
        // Personalized rating state only when a user resolves; an anonymous caller carries none.
        const ratingStatus =
          user === null
            ? undefined
            : submission.user_id === user.id
              ? 'own'
              : viewerRatings.has(submission.id)
                ? 'rated'
                : 'unrated'
        return {
          submission_id: submission.id,
          anonymous_number: index + 1,
          ...optionalField('rating_status', ratingStatus),
          ...(operator
            ? {
                owner_id: submission.user_id,
                ...optionalField('owner_name', ownerNames.get(submission.user_id)),
                source_kind: submission.source_kind,
                repo_url: submission.repo_url,
                commit_sha: submission.commit_sha,
                local_path: submission.local_path,
                ref: submission.ref,
              }
            : {}),
        }
      })
    },
  )

  // The agent profile: one owner's submission history for an environment, with every commit they
  // submitted across seasons (including superseded rows), each joined with its per-stage validation
  // log and its recent watch/replay recording ids. Keyed by environment id and owner id so a future
  // Hearts agent stays separate from the same user's Flappy Bird agent. Open (read-only); owner-only
  // affordances (the Stage 9 debug view) gate on the client comparing this owner_id to its identity.
  app.get<{ Params: { envId: string; ownerId: string } }>(
    '/api/environments/:envId/agents/:ownerId',
    async (request) => {
      const [submissions, submissionTarget, playTarget] = await Promise.all([
        deps.storage.listSubmissionsByUser(request.params.ownerId, request.params.envId),
        deps.storage.getOpenSubmissionSeason(request.params.envId),
        deps.storage.getPublicPlaySeason(request.params.envId),
      ])
      const detailed = await Promise.all(
        submissions.map(async (submission) => ({
          ...submission,
          checks: await deps.storage.listSubmissionChecks(submission.id),
          replays: await deps.storage.listRecordingsBySubmission(
            submission.id,
            PROFILE_REPLAY_LIMIT,
          ),
        })),
      )
      // The owner's rating prompt per season they submitted into, so the profile can show what each
      // round's raters were asked to evaluate. Keyed by the owner (not the caller), so any viewer sees
      // it; only non-blank prompts are returned.
      const seasonIds = [...new Set(submissions.map((submission) => submission.season_id))]
      const author_prompts: Record<string, string> = {}
      await Promise.all(
        seasonIds.map(async (seasonId) => {
          const row = await deps.storage.getAgentRatingPrompt(seasonId, request.params.ownerId)
          if (row !== undefined && row.prompt !== '') {
            author_prompts[seasonId] = row.prompt
          }
        }),
      )
      // The owner's display name beside the stable owner id, but only for an owner who actually has a
      // submission here: otherwise this open route would resolve a name for any id at all (pending,
      // banned, or never-submitted accounts), an id-to-name oracle. Omitted when the directory has no
      // row, and never sent to a masked (anonymous or guest) caller, who is not entitled to see user
      // names.
      const caller = await deps.identity.resolveUser(request)
      const ownerProfile =
        namesVisible(caller) && submissions.length > 0
          ? (await deps.userDirectory.profilesFor([request.params.ownerId])).get(
              request.params.ownerId,
            )
          : undefined
      return {
        env_id: request.params.envId,
        owner_id: request.params.ownerId,
        ...optionalField('owner_name', ownerProfile?.name),
        ...optionalField('owner_github', ownerProfile?.githubUsername),
        submission_season_id: submissionTarget?.id ?? null,
        play_season_id: playTarget?.id ?? null,
        submissions: detailed,
        author_prompts,
      }
    },
  )
}
