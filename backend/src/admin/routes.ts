/**
 * The operator-gated admin HTTP API (Stage 6.3): the stable contract the admin console and any
 * headless client drive. It declares and configures iterations, flips the three independent gates
 * (submission window, public play window, release status), triggers and re-runs the workflow,
 * inspects status, and streams a running run's container logs over WebSocket.
 *
 * Every route here lives under `/api/admin` and is gated by one `onRequest` operator guard on the
 * encapsulated plugin, so there is a single authorization choke point rather than per-route code. A
 * non-operator gets `403 not_operator` before any work runs. The public board/history reads do not go
 * through this prefix (see `leaderboards/routes.ts`); they only ever return released iterations, so
 * unreleased results cannot leak no matter the caller.
 *
 * Route shape note: the plan sketched action endpoints as `…/submissions:open`. Fastify's router
 * parses a mid-segment colon as a path parameter (so `:open` and `:close` collide as one route), so
 * the open/close/cancel actions are modeled as path segments (`…/submissions/open`) instead — the
 * same contract, expressed in a form the router accepts.
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'

import { DEPS_VERSION } from '../deps-version.js'
import type { EnvironmentMeta, EnvironmentRegistry } from '../environments.js'
import { isOperator, resolveUserId } from '../identity.js'
import { iterationView, runView } from '../iteration-views.js'
import { buildSchedule, type SubmissionRef } from '../scheduler/build-schedule.js'
import type { ClientSocket } from '../session/live-session.js'
import type { Storage } from '../storage/index.js'
import { IterationConfigSchema } from '../storage/iteration-config.js'
import type { RunEvent, WorkflowRunner } from '../workflow/runner.js'

/** Everything the admin routes need beyond the Fastify instance. */
export interface AdminDeps {
  storage: Storage
  environments: EnvironmentRegistry
  /** The background execution seam; the trigger enqueues onto it and the log stream subscribes to it. */
  workflowRunner: WorkflowRunner
  /** The operator allowlist `isOperator` consults; the single authorization predicate for this prefix. */
  operatorAllowlist: readonly string[]
  /** The dependency-set version a freshly declared iteration pins by default. */
  depsVersion?: number
}

/** The operator's iteration-wide rating prompt is display-only guidance; cap it so it stays a prompt. */
const RATING_PROMPT_MAX = 2_000

/** The optional body accepted when declaring an iteration. */
const DeclareIterationBodySchema = z.strictObject({
  label: z.string().nullable().optional(),
  deps_version: z.int().positive().optional(),
})

/** The optional body accepted when setting or clearing the operator rating prompt. */
const RatingPromptBodySchema = z.strictObject({
  prompt: z.string().max(RATING_PROMPT_MAX).nullable().optional(),
})

/** Whether a run is still in progress, so a re-run is refused and a cancel is meaningful. */
const IN_PROGRESS_RUN = new Set(['pending', 'running'])

/**
 * Register the admin API under `/api/admin`, gated by a single operator `onRequest` guard. Returns
 * nothing; it mutates the passed instance by registering an encapsulated plugin.
 */
export async function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): Promise<void> {
  const depsVersion = deps.depsVersion ?? DEPS_VERSION

  await app.register(
    async (admin) => {
      // The single authorization choke point for the whole prefix. Identity rides the header on a
      // normal request and the `user` query parameter on a WebSocket upgrade (a browser cannot set a
      // header on the upgrade), resolved by the one identity function. A non-operator is rejected here
      // before any handler — including the log-stream upgrade — runs.
      admin.addHook('onRequest', async (request, reply) => {
        const userId = resolveUserId(request.headers, request.query as Record<string, string>)
        if (!isOperator(userId, deps.operatorAllowlist)) {
          return reply.code(403).send({ error: 'operator access required', code: 'not_operator' })
        }
      })

      // --- Declare ---------------------------------------------------------------------------
      // Create an unreleased, submission-closed, play-closed iteration for the environment with a
      // default config carrying the current deps_version. Declaring does not auto-close any open
      // iteration; opening/closing are explicit lifecycle actions below.
      admin.post<{
        Params: { envId: string }
        Body: unknown
      }>('/environments/:envId/iterations', async (request, reply) => {
        const meta = deps.environments.get(request.params.envId)
        if (meta === undefined) {
          return reply.code(404).send({ error: 'no such environment' })
        }
        const parsed = DeclareIterationBodySchema.safeParse(request.body ?? {})
        if (!parsed.success) {
          return reply.code(400).send({
            error: 'invalid iteration declaration',
            code: 'invalid_iteration_declaration',
            reason: zodReason(parsed.error),
          })
        }
        const iteration = await deps.storage.createIteration({
          env_id: request.params.envId,
          deps_version: parsed.data.deps_version ?? depsVersion,
          label: parsed.data.label ?? null,
        })
        return reply.code(201).send(iterationView(iteration))
      })

      // --- Configure -------------------------------------------------------------------------
      // Replace the whole IterationConfig through the typed codec, validating slot counts against the
      // environment metadata. A config edit once runs exist (or a deps_version change once submissions
      // exist) is destructive, so it needs an explicit `?force=true` after the console's confirmation.
      admin.put<{ Params: { id: string }; Querystring: { force?: string }; Body: unknown }>(
        '/iterations/:id/config',
        async (request, reply) => {
          const iteration = await deps.storage.getIteration(request.params.id)
          if (iteration === undefined) {
            return reply.code(404).send({ error: 'no such iteration' })
          }
          const parsed = IterationConfigSchema.safeParse(request.body)
          if (!parsed.success) {
            const issue = parsed.error.issues[0]
            const path = issue && issue.path.length > 0 ? issue.path.join('.') : '(root)'
            return reply.code(400).send({
              error: 'invalid iteration config',
              code: 'invalid_config',
              reason: issue ? `${path}: ${issue.message}` : 'invalid iteration config',
            })
          }
          const meta = deps.environments.get(iteration.env_id)
          if (meta !== undefined) {
            const slotIssue = validateSlotCounts(parsed.data.matches, meta)
            if (slotIssue !== null) {
              return reply.code(400).send({
                error: 'invalid iteration config',
                code: 'invalid_config',
                reason: slotIssue,
              })
            }
          }
          const force = parseForce(request.query.force)
          if (force) {
            await cancelActiveRunsForForcedEdit(deps, iteration.id)
          }
          const result = await deps.storage.updateIterationConfig(request.params.id, parsed.data, {
            force,
          })
          if (!result.ok) {
            return reply.code(409).send({ error: result.conflict, code: result.conflict })
          }
          return reply.code(200).send(iterationView(result.iteration))
        },
      )

      // --- Rating prompt ---------------------------------------------------------------------
      // Set or clear the operator's iteration-wide rating prompt. Unlike config, this is editable at
      // any point in the iteration's life — it is display-only and never affects workflow execution.
      admin.put<{ Params: { id: string }; Body: unknown }>(
        '/iterations/:id/rating-prompt',
        async (request, reply) => {
          const iteration = await deps.storage.getIteration(request.params.id)
          if (iteration === undefined) {
            return reply.code(404).send({ error: 'no such iteration' })
          }
          const parsed = RatingPromptBodySchema.safeParse(request.body ?? {})
          if (!parsed.success) {
            const tooLong = parsed.error.issues.some(
              (issue) => issue.path[0] === 'prompt' && issue.code === 'too_big',
            )
            return reply.code(400).send({
              error: tooLong ? 'rating prompt too long' : 'invalid rating prompt',
              code: tooLong ? 'rating_prompt_too_long' : 'invalid_rating_prompt',
              reason: zodReason(parsed.error),
            })
          }
          const raw = parsed.data.prompt
          const prompt = raw === undefined || raw === null || raw === '' ? null : raw
          await deps.storage.setIterationRatingPrompt(request.params.id, prompt)
          const updated = await deps.storage.getIteration(request.params.id)
          return reply.code(200).send(iterationView(updated ?? iteration))
        },
      )

      // --- Submission window -----------------------------------------------------------------
      admin.post<{ Params: { id: string } }>('/iterations/:id/submissions/open', (request, reply) =>
        flipSubmission(deps, reply, request.params.id, 'open'),
      )
      admin.post<{ Params: { id: string } }>(
        '/iterations/:id/submissions/close',
        (request, reply) => flipSubmission(deps, reply, request.params.id, 'closed'),
      )

      // --- Public play window ----------------------------------------------------------------
      admin.post<{ Params: { id: string } }>('/iterations/:id/play/open', (request, reply) =>
        flipPlay(deps, reply, request.params.id, 'open'),
      )
      admin.post<{ Params: { id: string } }>('/iterations/:id/play/close', (request, reply) =>
        flipPlay(deps, reply, request.params.id, 'closed'),
      )

      // --- Release ---------------------------------------------------------------------------
      admin.post<{ Params: { id: string } }>('/iterations/:id/release', (request, reply) =>
        flipRelease(deps, reply, request.params.id, 'released'),
      )
      admin.post<{ Params: { id: string } }>('/iterations/:id/unrelease', (request, reply) =>
        flipRelease(deps, reply, request.params.id, 'unreleased'),
      )

      // --- Trigger / re-run ------------------------------------------------------------------
      // Snapshot the config (incl. deps) and the eligible ready submissions, build the concrete
      // schedule with the pure scheduler, persist it with a pending run row, then enqueue the runner
      // and return the run id immediately. Never blocks on containers.
      admin.post<{ Params: { id: string } }>('/iterations/:id/runs', async (request, reply) => {
        const iteration = await deps.storage.getIteration(request.params.id)
        if (iteration === undefined) {
          return reply.code(404).send({ error: 'no such iteration' })
        }
        const latest = await deps.storage.getLatestRun(iteration.id)
        if (latest !== undefined && IN_PROGRESS_RUN.has(latest.status)) {
          return reply.code(409).send({
            error: 'a run is already in progress for this iteration',
            code: 'run_in_progress',
            run_id: latest.id,
          })
        }
        const config = iterationView(iteration).config
        const meta = deps.environments.get(iteration.env_id)
        const ready = await deps.storage.listActiveSubmissionsByIteration(iteration.id, 'ready')
        const submissions: SubmissionRef[] = ready.map((s) => ({
          kind: 'submission',
          submission_id: s.id,
          user_id: s.user_id,
        }))
        const schedule = buildSchedule({
          matches: config.matches,
          submissions,
          seatOrderMatters: meta?.seat_order_matters ?? false,
        })
        if (schedule.length === 0) {
          return reply
            .code(409)
            .send({ error: 'the iteration resolves to an empty schedule', code: 'empty_schedule' })
        }
        const requestedBy = resolveUserId(request.headers)
        const run = await deps.storage.createRunWithSchedule(
          iteration.id,
          requestedBy,
          submissions,
          schedule,
        )
        deps.workflowRunner.enqueue(run.id)
        return reply.code(201).send({ id: run.id, status: run.status })
      })

      // --- Cancel ----------------------------------------------------------------------------
      admin.post<{ Params: { id: string; runId: string } }>(
        '/iterations/:id/runs/:runId/cancel',
        async (request, reply) => {
          const run = await deps.storage.getRun(request.params.runId)
          if (run === undefined || run.iteration_id !== request.params.id) {
            return reply.code(404).send({ error: 'no such run' })
          }
          if (!IN_PROGRESS_RUN.has(run.status)) {
            return reply
              .code(409)
              .send({ error: 'run is not in progress', code: 'run_not_in_progress' })
          }
          deps.workflowRunner.cancel(run.id)
          return reply.code(202).send({ id: run.id })
        },
      )

      // --- Status / list ---------------------------------------------------------------------
      // The full admin view: config, all three gates, the latest run with its per-game statuses, and
      // the computed boards even while unreleased. The board fields are empty until a run completes
      // (automated) or ratings arrive (human); steps 5/6 shape the public response from these.
      admin.get<{ Params: { id: string } }>('/iterations/:id', async (request, reply) => {
        const iteration = await deps.storage.getIteration(request.params.id)
        if (iteration === undefined) {
          return reply.code(404).send({ error: 'no such iteration' })
        }
        const latest = await deps.storage.getLatestRun(iteration.id)
        const games = latest === undefined ? [] : await deps.storage.listRunGames(latest.id)
        const [automated, human] = await Promise.all([
          deps.storage.getAutomatedBoard(iteration.id),
          deps.storage.aggregateRatingsByAgent(iteration.id),
        ])
        return reply.code(200).send({
          iteration: iterationView(iteration),
          latest_run: latest === undefined ? null : runView(latest, games),
          board: { automated, human },
        })
      })

      admin.get<{ Params: { envId: string } }>(
        '/environments/:envId/iterations',
        async (request, reply) => {
          const iterations = await deps.storage.listIterations(request.params.envId, {
            includeUnreleased: true,
          })
          return reply.code(200).send(iterations.map(iterationView))
        },
      )

      // --- Log stream (WebSocket) ------------------------------------------------------------
      // Relay the running workflow's per-match container log lines and game-status transitions live,
      // then send a terminal event and close. Live-only: a late subscriber misses lines emitted before
      // it attached (buffered backlog is deferred polish). A run already terminal at attach time gets
      // an immediate terminal event and close, so the console always learns the run is done.
      admin.get<{ Params: { id: string; runId: string } }>(
        '/iterations/:id/runs/:runId/logs/ws',
        { websocket: true },
        (socket, request) => {
          void attachLogStream(deps, socket as unknown as ClientSocket, {
            iterationId: request.params.id,
            runId: request.params.runId,
          })
        },
      )
    },
    { prefix: '/api/admin' },
  )
}

/** A minimal close-capable socket, matching the `@fastify/websocket` socket surface we use. */
interface CloseableSocket extends ClientSocket {
  on(event: 'close', listener: () => void): void
}

/**
 * Wire one log-stream subscriber. Validates the run belongs to the iteration, sends an immediate
 * terminal for an already-finished run, otherwise subscribes to the runner and relays each event,
 * closing on the terminal. The subscription is torn down when the socket closes.
 */
async function attachLogStream(
  deps: AdminDeps,
  socket: ClientSocket,
  ids: { iterationId: string; runId: string },
): Promise<void> {
  const closeable = socket as CloseableSocket
  const run = await deps.storage.getRun(ids.runId)
  if (run === undefined || run.iteration_id !== ids.iterationId) {
    socket.close()
    return
  }
  const send = (event: RunEvent): void => {
    try {
      socket.send(JSON.stringify(event))
    } catch {
      // Socket already gone; the close handler tears the subscription down.
    }
  }

  // An already-terminal run has no live runner behind it. Emit its terminal verdict and close, on a
  // later tick so a just-connected client has attached its message listener first.
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
    setImmediate(() => {
      send({ type: 'terminal', status: run.status as 'completed' | 'failed' | 'cancelled' })
      socket.close()
    })
    return
  }

  let unsubscribe = (): void => {}
  unsubscribe = deps.workflowRunner.subscribe(ids.runId, (event) => {
    send(event)
    if (event.type === 'terminal') {
      unsubscribe()
      socket.close()
    }
  })
  closeable.on('close', () => unsubscribe())
}

/** Validate each match's total slot count against the environment metadata; the first issue or null. */
function validateSlotCounts(
  matches: ReadonlyArray<{ slots: readonly string[] }>,
  meta: EnvironmentMeta,
): string | null {
  for (let i = 0; i < matches.length; i++) {
    const count = matches[i]?.slots.length ?? 0
    if (count > meta.max_slots) {
      return `matches.${i}.slots: ${count} slots exceeds the environment maximum of ${meta.max_slots}`
    }
    if (count < meta.min_slots) {
      return `matches.${i}.slots: ${count} slots is below the environment minimum of ${meta.min_slots}`
    }
  }
  return null
}

/** Parse the `?force=` query flag; the console sends it after a destructive-edit confirmation. */
function parseForce(raw: string | undefined): boolean {
  return raw === 'true' || raw === '1' || raw === 'yes'
}

/** A compact, stable explanation of the first zod issue for 400 responses. */
function zodReason(error: z.ZodError): string {
  const issue = error.issues[0]
  if (issue === undefined) {
    return 'invalid request body'
  }
  const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
  return `${path}: ${issue.message}`
}

async function flipSubmission(
  deps: AdminDeps,
  reply: FastifyReply,
  id: string,
  status: 'open' | 'closed',
): Promise<unknown> {
  if (!(await ensureExists(deps, reply, id))) {
    return reply
  }
  const result = await deps.storage.setSubmissionStatus(id, status)
  if (!result.ok) {
    return reply.code(409).send({ error: result.conflict, code: result.conflict })
  }
  return reply.code(200).send(iterationView(result.iteration))
}

/** Forced config edits delete run rows; cancel live containers before those rows disappear. */
async function cancelActiveRunsForForcedEdit(deps: AdminDeps, iterationId: string): Promise<void> {
  const activeRuns = [
    ...(await deps.storage.listRunsByStatus('pending')),
    ...(await deps.storage.listRunsByStatus('running')),
  ].filter((run) => run.iteration_id === iterationId)
  for (const run of activeRuns) {
    deps.workflowRunner.cancel(run.id)
  }
}

async function flipPlay(
  deps: AdminDeps,
  reply: FastifyReply,
  id: string,
  status: 'open' | 'closed',
): Promise<unknown> {
  if (!(await ensureExists(deps, reply, id))) {
    return reply
  }
  const result = await deps.storage.setPlayStatus(id, status)
  if (!result.ok) {
    return reply.code(409).send({ error: result.conflict, code: result.conflict })
  }
  return reply.code(200).send(iterationView(result.iteration))
}

async function flipRelease(
  deps: AdminDeps,
  reply: FastifyReply,
  id: string,
  status: 'released' | 'unreleased',
): Promise<unknown> {
  if (!(await ensureExists(deps, reply, id))) {
    return reply
  }
  const iteration = await deps.storage.setReleaseStatus(id, status)
  return reply.code(200).send(iterationView(iteration))
}

/** 404 when the iteration is absent so the gate setters never run against a missing row. */
async function ensureExists(deps: AdminDeps, reply: FastifyReply, id: string): Promise<boolean> {
  const iteration = await deps.storage.getIteration(id)
  if (iteration === undefined) {
    await reply.code(404).send({ error: 'no such iteration' })
    return false
  }
  return true
}
