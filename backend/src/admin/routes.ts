/**
 * The operator-gated admin HTTP API (Stage 6.3): the stable contract the admin console and any
 * headless client drive. It declares and configures seasons, flips the three independent gates
 * (submission window, public play window, release status), triggers and re-runs the workflow,
 * inspects status, and streams a running run's container logs over WebSocket.
 *
 * Every route here lives under `/api/admin` and is gated by one `onRequest` operator guard on the
 * encapsulated plugin, so there is a single authorization choke point rather than per-route code. A
 * non-operator gets `403 not_operator` before any work runs. The public board/history reads do not go
 * through this prefix (see `leaderboards/routes.ts`); they only ever return released seasons, so
 * unreleased results cannot leak no matter the caller.
 *
 * Route shape note: the plan sketched action endpoints as `…/submissions:open`. Fastify's router
 * parses a mid-segment colon as a path parameter (so `:open` and `:close` collide as one route), so
 * the open/close/cancel actions are modeled as path segments (`…/submissions/open`) instead — the
 * same contract, expressed in a form the router accepts.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGzip } from 'node:zlib'

import type { FastifyInstance, FastifyReply } from 'fastify'
import tar from 'tar-fs'
import { z } from 'zod'

import { DEPS_VERSION } from '../deps-version.js'
import type { EnvironmentMeta, EnvironmentRegistry } from '../environments.js'
import { isOperator, resolveUserId } from '../identity.js'
import { buildSchedule, type SubmissionRef } from '../scheduler/build-schedule.js'
import { runGameView, runSummaryView, runView, seasonView } from '../season-views.js'
import type { ClientSocket } from '../session/live-session.js'
import type { Storage, Submission } from '../storage/index.js'
import { SeasonConfigSchema } from '../storage/season-config.js'
import { SnapshotMissingError, type SubmissionSnapshotStore } from '../submission/snapshot-store.js'
import type { RunEvent, WorkflowRunner } from '../workflow/runner.js'

/** Everything the admin routes need beyond the Fastify instance. */
export interface AdminDeps {
  storage: Storage
  environments: EnvironmentRegistry
  /** The background execution seam; the trigger enqueues onto it and the log stream subscribes to it. */
  workflowRunner: WorkflowRunner
  /** The operator allowlist `isOperator` consults; the single authorization predicate for this prefix. */
  operatorAllowlist: readonly string[]
  /** The dependency-set version a freshly declared season pins by default. */
  depsVersion?: number
  /** Versions the deployment can actually serve with a concrete session base image. */
  knownDepsVersions: ReadonlySet<number>
  /** The submission-snapshot store the download routes read (individual submission + whole season). */
  snapshots: SubmissionSnapshotStore
}

/** The operator's season-wide rating prompt is display-only guidance; cap it so it stays a prompt. */
const RATING_PROMPT_MAX = 2_000

/** A season label is a short operator-facing name; cap it so it stays a label rather than prose. */
const SEASON_LABEL_MAX = 100

/** The optional body accepted when declaring a season. */
const DeclareSeasonBodySchema = z.strictObject({
  label: z.string().nullable().optional(),
  deps_version: z.int().positive().optional(),
})

/** The body accepted when renaming a season; a null or empty label clears it back to unnamed. */
const RenameSeasonBodySchema = z.strictObject({
  label: z.string().max(SEASON_LABEL_MAX).nullable().optional(),
})

/** The optional body accepted when setting or clearing the operator rating prompt. */
const RatingPromptBodySchema = z.strictObject({
  prompt: z.string().max(RATING_PROMPT_MAX).nullable().optional(),
})

/** Whether a run is still in progress, so a re-run is refused and a cancel is meaningful. */
const IN_PROGRESS_RUN = new Set(['pending', 'running'])

/** Reduce a user id to a filesystem-safe token for an archive folder/filename (handles stay readable). */
function sanitizeForPath(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '_')
  return safe === '' ? 'submission' : safe
}

/** The per-submission folder inside a season archive: `<user>-<id8>` (collision-free via the id suffix). */
function submissionFolderName(submission: Submission): string {
  return `${sanitizeForPath(submission.user_id)}-${submission.id.slice(0, 8)}`
}

/** The download filename for a single submission's snapshot. */
function submissionArchiveName(submission: Submission): string {
  return `${submissionFolderName(submission)}.tar.gz`
}

/** The operator-facing metadata copied into a download (never any credential; the row holds none). */
function submissionMetadata(submission: Submission): {
  id: string
  user_id: string
  source_kind: string
  repo_url: string | null
  commit_sha: string | null
  ref: string | null
  status: string
  created_at: string
} {
  return {
    id: submission.id,
    user_id: submission.user_id,
    source_kind: submission.source_kind,
    repo_url: submission.repo_url,
    commit_sha: submission.commit_sha,
    ref: submission.ref,
    status: submission.status,
    created_at: submission.created_at,
  }
}

/**
 * Assemble a whole season's active submissions into one staging directory: each submission that has a
 * snapshot under its own `<user>-<id8>/` folder with a `submission.json`, plus a top-level `season.json`
 * index. A submission whose snapshot is missing is listed in `skipped` rather than failing the archive.
 * Returns the staging path for the caller to pack and then remove. On any other error the staging dir is
 * cleaned up before rethrowing.
 */
async function buildSeasonSubmissionArchive(
  deps: AdminDeps,
  season: { id: string; env_id: string },
): Promise<string> {
  const active = await deps.storage.listActiveSubmissionsBySeason(season.id)
  const staging = await mkdtemp(join(tmpdir(), 'gs-season-'))
  try {
    const included: Array<{ folder: string; id: string; user_id: string; status: string }> = []
    const skipped: string[] = []
    for (const submission of active) {
      const folder = submissionFolderName(submission)
      const dest = join(staging, folder)
      try {
        await deps.snapshots.materializeInto(submission.id, dest)
      } catch (error) {
        if (error instanceof SnapshotMissingError) {
          await rm(dest, { recursive: true, force: true }).catch(() => undefined)
          skipped.push(submission.id)
          continue
        }
        throw error
      }
      await writeFile(
        join(dest, 'submission.json'),
        JSON.stringify(submissionMetadata(submission), null, 2),
      )
      included.push({
        folder,
        id: submission.id,
        user_id: submission.user_id,
        status: submission.status,
      })
    }
    await writeFile(
      join(staging, 'season.json'),
      JSON.stringify(
        { season_id: season.id, env_id: season.env_id, submissions: included, skipped },
        null,
        2,
      ),
    )
    return staging
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * The operator submission routes (list + individual download + whole-season archive), registered on the
 * already operator-gated admin instance so they share the one `onRequest` guard.
 */
function registerSubmissionRoutes(admin: FastifyInstance, deps: AdminDeps): void {
  // The season's active submissions (one current attempt per participant, any status), each tagged with
  // whether a downloadable snapshot exists so the console can disable a download that has none.
  admin.get<{ Params: { id: string } }>('/seasons/:id/submissions', async (request, reply) => {
    const season = await deps.storage.getSeason(request.params.id)
    if (season === undefined) {
      return reply.code(404).send({ error: 'no such season' })
    }
    const active = await deps.storage.listActiveSubmissionsBySeason(season.id)
    const rows = await Promise.all(
      active.map(async (submission) => ({
        ...submissionMetadata(submission),
        has_snapshot: await deps.snapshots.exists(submission.id),
      })),
    )
    return reply.code(200).send(rows)
  })

  // Download one submission's source as the stored `.tar.gz` (the filtered checkout, no `.git`).
  admin.get<{ Params: { submissionId: string } }>(
    '/submissions/:submissionId/download',
    async (request, reply) => {
      const submission = await deps.storage.getSubmission(request.params.submissionId)
      if (submission === undefined) {
        return reply.code(404).send({ error: 'no such submission' })
      }
      if (!(await deps.snapshots.exists(submission.id))) {
        return reply
          .code(404)
          .send({ error: 'no snapshot for this submission', code: 'no_snapshot' })
      }
      return reply
        .type('application/gzip')
        .header(
          'content-disposition',
          `attachment; filename="${submissionArchiveName(submission)}"`,
        )
        .send(deps.snapshots.stream(submission.id))
    },
  )

  // Download a whole season as one streamed `.tar.gz`. The staging dir is removed once the response has
  // finished sending (or aborted), tracked by the gzip stream's close/error.
  admin.get<{ Params: { id: string } }>(
    '/seasons/:id/submissions/download',
    async (request, reply) => {
      const season = await deps.storage.getSeason(request.params.id)
      if (season === undefined) {
        return reply.code(404).send({ error: 'no such season' })
      }
      const staging = await buildSeasonSubmissionArchive(deps, season)
      const archive = tar.pack(staging, { sort: true }).pipe(createGzip())
      let cleaned = false
      const cleanup = (): void => {
        if (cleaned) {
          return
        }
        cleaned = true
        void rm(staging, { recursive: true, force: true })
      }
      archive.on('close', cleanup)
      archive.on('error', cleanup)
      return reply
        .type('application/gzip')
        .header(
          'content-disposition',
          `attachment; filename="season-${season.id.slice(0, 8)}.tar.gz"`,
        )
        .send(archive)
    },
  )
}

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
      // Create an unreleased, submission-closed, play-closed season for the environment with a
      // default config carrying the current deps_version. Declaring does not auto-close any open
      // season; opening/closing are explicit lifecycle actions below.
      admin.post<{
        Params: { envId: string }
        Body: unknown
      }>('/environments/:envId/seasons', async (request, reply) => {
        const meta = deps.environments.get(request.params.envId)
        if (meta === undefined) {
          return reply.code(404).send({ error: 'no such environment' })
        }
        const parsed = DeclareSeasonBodySchema.safeParse(request.body ?? {})
        if (!parsed.success) {
          return reply.code(400).send({
            error: 'invalid season declaration',
            code: 'invalid_season_declaration',
            reason: zodReason(parsed.error),
          })
        }
        const requestedDepsVersion = parsed.data.deps_version ?? depsVersion
        if (!deps.knownDepsVersions.has(requestedDepsVersion)) {
          return unsupportedDepsVersion(reply, requestedDepsVersion, 'invalid_season_declaration')
        }
        const season = await deps.storage.createSeason({
          env_id: request.params.envId,
          deps_version: requestedDepsVersion,
          label: parsed.data.label ?? null,
        })
        return reply.code(201).send(seasonView(season))
      })

      // --- Configure -------------------------------------------------------------------------
      // Replace the whole SeasonConfig through the typed codec, validating slot counts against the
      // environment metadata. A config edit once runs exist (or a deps_version change once submissions
      // exist) is destructive, so it needs an explicit `?force=true` after the console's confirmation.
      admin.put<{ Params: { id: string }; Querystring: { force?: string }; Body: unknown }>(
        '/seasons/:id/config',
        async (request, reply) => {
          const season = await deps.storage.getSeason(request.params.id)
          if (season === undefined) {
            return reply.code(404).send({ error: 'no such season' })
          }
          const parsed = SeasonConfigSchema.safeParse(request.body)
          if (!parsed.success) {
            const issue = parsed.error.issues[0]
            const path = issue && issue.path.length > 0 ? issue.path.join('.') : '(root)'
            return reply.code(400).send({
              error: 'invalid season config',
              code: 'invalid_config',
              reason: issue ? `${path}: ${issue.message}` : 'invalid season config',
            })
          }
          if (!deps.knownDepsVersions.has(parsed.data.deps_version)) {
            return unsupportedDepsVersion(reply, parsed.data.deps_version, 'invalid_config')
          }
          const meta = deps.environments.get(season.env_id)
          if (meta !== undefined) {
            const slotIssue = validateSlotCounts(parsed.data.matches, meta)
            if (slotIssue !== null) {
              return reply.code(400).send({
                error: 'invalid season config',
                code: 'invalid_config',
                reason: slotIssue,
              })
            }
          }
          const force = parseForce(request.query.force)
          // A forced `deps_version` change wipes the season's submissions; capture them first so their
          // now-orphaned snapshots can be reclaimed once the edit lands.
          let priorSubmissionIds: string[] = []
          if (force) {
            await cancelActiveRunsForForcedEdit(deps, season.id)
            priorSubmissionIds = (await deps.storage.listActiveSubmissionsBySeason(season.id)).map(
              (submission) => submission.id,
            )
          }
          const result = await deps.storage.updateSeasonConfig(request.params.id, parsed.data, {
            force,
          })
          if (!result.ok) {
            return reply.code(409).send({ error: result.conflict, code: result.conflict })
          }
          // Best-effort snapshot cleanup: only the rows the forced edit actually deleted (gone now).
          for (const id of priorSubmissionIds) {
            if ((await deps.storage.getSubmission(id)) === undefined) {
              await deps.snapshots.delete(id).catch(() => undefined)
            }
          }
          return reply.code(200).send(seasonView(result.season))
        },
      )

      // --- Rating prompt ---------------------------------------------------------------------
      // Set or clear the operator's season-wide rating prompt. Unlike config, this is editable at
      // any point in the season's life — it is display-only and never affects workflow execution.
      admin.put<{ Params: { id: string }; Body: unknown }>(
        '/seasons/:id/rating-prompt',
        async (request, reply) => {
          const season = await deps.storage.getSeason(request.params.id)
          if (season === undefined) {
            return reply.code(404).send({ error: 'no such season' })
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
          await deps.storage.setSeasonRatingPrompt(request.params.id, prompt)
          const updated = await deps.storage.getSeason(request.params.id)
          return reply.code(200).send(seasonView(updated ?? season))
        },
      )

      // --- Rename ----------------------------------------------------------------------------
      // Set or clear the season's operator-facing label. Like the rating prompt, the label is purely
      // descriptive and never affects execution, so it is editable at any point in the season's life.
      admin.put<{ Params: { id: string }; Body: unknown }>(
        '/seasons/:id/label',
        async (request, reply) => {
          const season = await deps.storage.getSeason(request.params.id)
          if (season === undefined) {
            return reply.code(404).send({ error: 'no such season' })
          }
          const parsed = RenameSeasonBodySchema.safeParse(request.body ?? {})
          if (!parsed.success) {
            const tooLong = parsed.error.issues.some(
              (issue) => issue.path[0] === 'label' && issue.code === 'too_big',
            )
            return reply.code(400).send({
              error: tooLong ? 'season label too long' : 'invalid season label',
              code: tooLong ? 'season_label_too_long' : 'invalid_season_label',
              reason: zodReason(parsed.error),
            })
          }
          const raw = parsed.data.label
          const label = raw === undefined || raw === null || raw.trim() === '' ? null : raw.trim()
          await deps.storage.setSeasonLabel(request.params.id, label)
          const updated = await deps.storage.getSeason(request.params.id)
          return reply.code(200).send(seasonView(updated ?? season))
        },
      )

      // --- Submission window -----------------------------------------------------------------
      admin.post<{ Params: { id: string } }>('/seasons/:id/submissions/open', (request, reply) =>
        flipSubmission(deps, reply, request.params.id, 'open'),
      )
      admin.post<{ Params: { id: string } }>('/seasons/:id/submissions/close', (request, reply) =>
        flipSubmission(deps, reply, request.params.id, 'closed'),
      )

      // --- Public play window ----------------------------------------------------------------
      admin.post<{ Params: { id: string } }>('/seasons/:id/play/open', (request, reply) =>
        flipPlay(deps, reply, request.params.id, 'open'),
      )
      admin.post<{ Params: { id: string } }>('/seasons/:id/play/close', (request, reply) =>
        flipPlay(deps, reply, request.params.id, 'closed'),
      )

      // --- Release ---------------------------------------------------------------------------
      admin.post<{ Params: { id: string } }>('/seasons/:id/release', (request, reply) =>
        flipRelease(deps, reply, request.params.id, 'released'),
      )
      admin.post<{ Params: { id: string } }>('/seasons/:id/unrelease', (request, reply) =>
        flipRelease(deps, reply, request.params.id, 'unreleased'),
      )

      // --- Trigger / re-run ------------------------------------------------------------------
      // Snapshot the config (incl. deps) and the eligible ready submissions, build the concrete
      // schedule with the pure scheduler, persist it with a pending run row, then enqueue the runner
      // and return the run id immediately. Never blocks on containers.
      admin.post<{ Params: { id: string } }>('/seasons/:id/runs', async (request, reply) => {
        const season = await deps.storage.getSeason(request.params.id)
        if (season === undefined) {
          return reply.code(404).send({ error: 'no such season' })
        }
        const latest = await deps.storage.getLatestRun(season.id)
        if (latest !== undefined && IN_PROGRESS_RUN.has(latest.status)) {
          return reply.code(409).send({
            error: 'a run is already in progress for this season',
            code: 'run_in_progress',
            run_id: latest.id,
          })
        }
        const config = seasonView(season).config
        const meta = deps.environments.get(season.env_id)
        const ready = await deps.storage.listActiveSubmissionsBySeason(season.id, 'ready')
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
            .send({ error: 'the season resolves to an empty schedule', code: 'empty_schedule' })
        }
        const requestedBy = resolveUserId(request.headers)
        const run = await deps.storage.createRunWithSchedule(
          season.id,
          requestedBy,
          submissions,
          schedule,
        )
        deps.workflowRunner.enqueue(run.id)
        return reply.code(201).send({ id: run.id, status: run.status })
      })

      // --- Cancel ----------------------------------------------------------------------------
      admin.post<{ Params: { id: string; runId: string } }>(
        '/seasons/:id/runs/:runId/cancel',
        async (request, reply) => {
          const run = await deps.storage.getRun(request.params.runId)
          if (run === undefined || run.season_id !== request.params.id) {
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
      admin.get<{ Params: { id: string } }>('/seasons/:id', async (request, reply) => {
        const season = await deps.storage.getSeason(request.params.id)
        if (season === undefined) {
          return reply.code(404).send({ error: 'no such season' })
        }
        const latest = await deps.storage.getLatestRun(season.id)
        const games = latest === undefined ? [] : await deps.storage.listRunGames(latest.id)
        // The board's matchup table mirrors the public read: the latest completed run's games (decoded),
        // the same run the automated board aggregates. This differs from `latest` when the most recent
        // run failed, so the preview's matchups always match the board it sits beside. Resolve that run
        // once and feed it into the board read so both describe the identical run.
        const completed = await deps.storage.getLatestCompletedRun(season.id)
        const automated = await deps.storage.getAutomatedBoard(season.id, completed)
        // The human board reuses the automated board's replay links, so build it after and pass it in.
        const human = await deps.storage.getHumanBoard(season.id, automated)
        const boardGames =
          completed === undefined
            ? []
            : (await deps.storage.listRunGames(completed.id)).map(runGameView)
        return reply.code(200).send({
          season: seasonView(season),
          latest_run: latest === undefined ? null : runView(latest, games),
          board: { automated, human, games: boardGames },
        })
      })

      // --- Runs list / detail ----------------------------------------------------------------
      // The season's runs, newest first, as lightweight summaries (no frozen snapshots) for the
      // console's runs list. A single run's full view — including its scheduled games — is served by
      // the detail route below when the operator opens it.
      admin.get<{ Params: { id: string } }>('/seasons/:id/runs', async (request, reply) => {
        const season = await deps.storage.getSeason(request.params.id)
        if (season === undefined) {
          return reply.code(404).send({ error: 'no such season' })
        }
        const runs = await deps.storage.listRunsBySeason(season.id)
        const counts = await deps.storage.countRunGamesBySeason(season.id)
        return reply.code(200).send(runs.map((run) => runSummaryView(run, counts.get(run.id) ?? 0)))
      })

      // One run's full view with its scheduled games, the run-details page's primary read. The run
      // must belong to the season in the path, mirroring the cancel route's cross-season guard.
      admin.get<{ Params: { id: string; runId: string } }>(
        '/seasons/:id/runs/:runId',
        async (request, reply) => {
          const run = await deps.storage.getRun(request.params.runId)
          if (run === undefined || run.season_id !== request.params.id) {
            return reply.code(404).send({ error: 'no such run' })
          }
          const games = await deps.storage.listRunGames(run.id)
          return reply.code(200).send(runView(run, games))
        },
      )

      // --- Submissions: list + downloads -----------------------------------------------------
      registerSubmissionRoutes(admin, deps)

      // --- Log stream (WebSocket) ------------------------------------------------------------
      // Relay the running workflow's per-match container log lines and game-status transitions live,
      // then send a terminal event and close. Live-only: a late subscriber misses lines emitted before
      // it attached (buffered backlog is deferred polish). A run already terminal at attach time gets
      // an immediate terminal event and close, so the console always learns the run is done.
      admin.get<{ Params: { id: string; runId: string } }>(
        '/seasons/:id/runs/:runId/logs/ws',
        { websocket: true },
        (socket, request) => {
          void attachLogStream(deps, socket as unknown as ClientSocket, {
            seasonId: request.params.id,
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
 * Wire one log-stream subscriber. Validates the run belongs to the season, sends an immediate
 * terminal for an already-finished run, otherwise subscribes to the runner and relays each event,
 * closing on the terminal. The subscription is torn down when the socket closes.
 */
async function attachLogStream(
  deps: AdminDeps,
  socket: ClientSocket,
  ids: { seasonId: string; runId: string },
): Promise<void> {
  const closeable = socket as CloseableSocket
  const run = await deps.storage.getRun(ids.runId)
  if (run === undefined || run.season_id !== ids.seasonId) {
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

/** Reject a season declaration/configuration that names no deployable base image. */
function unsupportedDepsVersion(
  reply: FastifyReply,
  depsVersion: number,
  code: 'invalid_season_declaration' | 'invalid_config',
): unknown {
  return reply.code(400).send({
    error: code === 'invalid_config' ? 'invalid season config' : 'invalid season declaration',
    code,
    reason: `deps_version ${depsVersion} is not supported by this deployment`,
  })
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
  return reply.code(200).send(seasonView(result.season))
}

/** Forced config edits delete run rows; cancel live containers before those rows disappear. */
async function cancelActiveRunsForForcedEdit(deps: AdminDeps, seasonId: string): Promise<void> {
  const activeRuns = [
    ...(await deps.storage.listRunsByStatus('pending')),
    ...(await deps.storage.listRunsByStatus('running')),
  ].filter((run) => run.season_id === seasonId)
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
  return reply.code(200).send(seasonView(result.season))
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
  const season = await deps.storage.setReleaseStatus(id, status)
  return reply.code(200).send(seasonView(season))
}

/** 404 when the season is absent so the gate setters never run against a missing row. */
async function ensureExists(deps: AdminDeps, reply: FastifyReply, id: string): Promise<boolean> {
  const season = await deps.storage.getSeason(id)
  if (season === undefined) {
    await reply.code(404).send({ error: 'no such season' })
    return false
  }
  return true
}
