import { type APIRequestContext, expect } from '@playwright/test'

import { ENV_ID } from './names.js'

/**
 * Thin wrappers over the real backend endpoints the specs drive through Playwright's API contexts,
 * so each spec composes a flow instead of re-declaring the same fetch-and-assert boilerplate. Every
 * wrapper asserts the status it expects (with the response text on failure, so a broken call reports
 * the server's reason).
 *
 * Identity is a Better Auth session cookie, not a header: each wrapper takes the `actor` context it
 * runs through, whose jar already holds a signed-in session (see the `admin` / `as` fixtures in
 * `fixtures.ts`). Administration and season-setup calls take the `admin` context; owner submissions,
 * ratings, author prompts, and session starts take the acting member's `as(handle)` context; public
 * reads accept any context.
 */

export interface Season {
  id: string
  label: string | null
}

/** The season-wide messaging override block, mirroring the backend's `SeasonOverrides['messaging']`. */
interface MessagingOverride {
  enabled?: boolean
  message_cap?: number
}

/** The explicit LLM season override the browser journey configures through the real admin endpoint. */
export interface LlmOverride {
  enabled?: boolean
  models?: ('large' | 'medium' | 'small')[]
  official?: { token_budget?: number; rate_limit_rpm?: number }
  development?: { token_budget?: number; rate_limit_rpm?: number }
}

/** The season config document the admin config GET/PUT round-trips (mirrors `SeasonConfig`). */
export interface SeasonConfigDoc {
  deps_version: number
  matches: MatchConfig[]
  overrides?: {
    step_timeout_ms?: number
    episode_timeout_ms?: number
    messaging?: MessagingOverride
    llm?: LlmOverride
    parameters?: Record<string, boolean | number | string | string[]>
  }
}

interface SubmissionRow {
  id: string
  status: 'pending' | 'ready' | 'static_failed' | 'build_failed' | 'load_failed'
  checks: { stage: string; status: string; detail: string | null }[]
}

export interface SessionRow {
  id: string
  status: 'starting' | 'running' | 'ended'
  recording_id: string | null
  parameters: Record<string, boolean | number | string | string[]>
}

/** One match design entry, mirroring the backend's MatchConfig codec. */
export interface MatchConfig {
  seats: ('submission' | `builtin:${string}`)[]
  seeds: number[]
  games: number
}

// --- Seasons -------------------------------------------------------------------------------------

/** Declare a fresh season (unreleased, both windows closed) for an environment (Flappy Bird by default). */
export async function declareSeason(
  admin: APIRequestContext,
  label: string,
  envId: string = ENV_ID,
): Promise<Season> {
  const res = await admin.post(`/api/admin/environments/${envId}/seasons`, { data: { label } })
  expect(res.status(), await res.text()).toBe(201)
  return (await res.json()) as Season
}

/** Permanently remove one closed, unreleased season that has no activity. */
export async function deleteSeason(admin: APIRequestContext, seasonId: string): Promise<void> {
  const res = await admin.delete(`/api/admin/seasons/${seasonId}`)
  expect(res.status(), await res.text()).toBe(204)
}

/** Replace a season's whole match design through the typed config endpoint. */
export async function configureMatches(
  admin: APIRequestContext,
  seasonId: string,
  matches: MatchConfig[],
  depsVersion = 1,
): Promise<void> {
  const res = await admin.put(`/api/admin/seasons/${seasonId}/config`, {
    data: { deps_version: depsVersion, matches },
  })
  expect(res.status(), await res.text()).toBe(200)
}

async function flipWindow(admin: APIRequestContext, path: string): Promise<void> {
  const res = await admin.post(path)
  expect(res.status(), await res.text()).toBe(200)
}

/** Fetch a season's current full config document through the admin detail endpoint. */
export async function getSeasonConfig(
  admin: APIRequestContext,
  seasonId: string,
): Promise<SeasonConfigDoc> {
  const res = await admin.get(`/api/admin/seasons/${seasonId}`)
  expect(res.status(), await res.text()).toBe(200)
  const body = (await res.json()) as { season: { config: SeasonConfigDoc } }
  return body.season.config
}

/** Merge selected season overrides through the full-replacement operator config endpoint. */
export async function setSeasonOverrides(
  admin: APIRequestContext,
  seasonId: string,
  overrides: NonNullable<SeasonConfigDoc['overrides']>,
): Promise<void> {
  const config = await getSeasonConfig(admin, seasonId)
  const res = await admin.put(`/api/admin/seasons/${seasonId}/config`, {
    data: {
      deps_version: config.deps_version,
      matches: config.matches,
      overrides: { ...config.overrides, ...overrides },
    },
  })
  expect(res.status(), await res.text()).toBe(200)
}

/**
 * Replace only the LLM block while preserving the rest of the full-replace season configuration.
 * This mirrors the administrator editor and lets E2E exercise a genuinely enabled season.
 */
export async function setLlmOverride(
  admin: APIRequestContext,
  seasonId: string,
  llm: LlmOverride,
): Promise<void> {
  const config = await getSeasonConfig(admin, seasonId)
  const res = await admin.put(`/api/admin/seasons/${seasonId}/config`, {
    data: {
      deps_version: config.deps_version,
      matches: config.matches,
      overrides: { ...config.overrides, llm },
    },
  })
  expect(res.status(), await res.text()).toBe(200)
}

export const openSubmissions = (admin: APIRequestContext, id: string): Promise<void> =>
  flipWindow(admin, `/api/admin/seasons/${id}/submissions/open`)
export const closeSubmissions = (admin: APIRequestContext, id: string): Promise<void> =>
  flipWindow(admin, `/api/admin/seasons/${id}/submissions/close`)
export const openPlay = (admin: APIRequestContext, id: string): Promise<void> =>
  flipWindow(admin, `/api/admin/seasons/${id}/play/open`)
export const closePlay = (admin: APIRequestContext, id: string): Promise<void> =>
  flipWindow(admin, `/api/admin/seasons/${id}/play/close`)
export const release = (admin: APIRequestContext, id: string): Promise<void> =>
  flipWindow(admin, `/api/admin/seasons/${id}/release`)

/** The seasons that currently hold the environment's unique open submission and play windows. */
export async function activeWindows(
  actor: APIRequestContext,
  envId: string = ENV_ID,
): Promise<{ submissionSeasonId: string | null; playSeasonId: string | null }> {
  const res = await actor.get(`/api/environments/${envId}/leaderboards`)
  expect(res.ok(), await res.text()).toBe(true)
  const body = (await res.json()) as {
    submission_season_id: string | null
    play_season_id: string | null
  }
  return { submissionSeasonId: body.submission_season_id, playSeasonId: body.play_season_id }
}

/**
 * Resolve a public season's display label through the seasons list, so a spec can name whatever
 * season currently holds a window by reading the same data the pages do (the alternative — hardcoding
 * a label — would couple a spec to which season holds a window, which the arcs change).
 */
export async function publicSeasonLabel(
  actor: APIRequestContext,
  envId: string,
  seasonId: string,
): Promise<string> {
  const res = await actor.get(`/api/seasons?envId=${encodeURIComponent(envId)}`)
  expect(res.ok(), await res.text()).toBe(true)
  const seasons = (await res.json()) as { id: string; label: string | null }[]
  const match = seasons.find((season) => season.id === seasonId)
  if (match === undefined) throw new Error(`no public season ${seasonId} in ${envId}`)
  return match.label ?? seasonId
}

/** Set the operator's season-wide rating prompt (display-only guidance shown to every rater). */
export async function setSeasonRatingPrompt(
  admin: APIRequestContext,
  seasonId: string,
  prompt: string,
): Promise<void> {
  const res = await admin.put(`/api/admin/seasons/${seasonId}/rating-prompt`, {
    data: { prompt },
  })
  expect(res.status(), await res.text()).toBe(200)
}

/**
 * Set an agent author's own rating prompt. The `owner` context must be the agent's author with an
 * active submission in the season, since the write is gated by `requireActive` and the ownership check.
 */
export async function setAuthorPrompt(
  owner: APIRequestContext,
  seasonId: string,
  prompt: string,
): Promise<void> {
  const res = await owner.put(`/api/seasons/${seasonId}/agent-rating-prompt`, {
    data: { prompt },
  })
  expect(res.status(), await res.text()).toBe(200)
}

// --- Submissions ---------------------------------------------------------------------------------

/** Submit a local-folder agent as the `owner` context; returns the pending submission id. */
export async function submitLocal(
  owner: APIRequestContext,
  localPath: string,
  envId: string = ENV_ID,
): Promise<string> {
  const res = await owner.post('/api/submissions', {
    data: { env_id: envId, local_path: localPath },
  })
  expect(res.status(), await res.text()).toBe(202)
  const body = (await res.json()) as { id: string; status: string }
  expect(body.status).toBe('pending')
  return body.id
}

/**
 * Poll the real validate-and-build pipeline to a terminal status (build and load run containers).
 * The `owner` context must own the submission (or be an admin), since the detail read is gated by
 * `requireUser` plus the ownership/operator check.
 */
export async function waitForTerminal(
  owner: APIRequestContext,
  id: string,
): Promise<SubmissionRow> {
  let row: SubmissionRow | undefined
  await expect
    .poll(
      async () => {
        const res = await owner.get(`/api/submissions/${id}`)
        expect(res.ok()).toBe(true)
        row = (await res.json()) as SubmissionRow
        return row.status
      },
      { timeout: 150_000, intervals: [1000, 2000, 3000] },
    )
    .not.toBe('pending')
  if (row === undefined) {
    throw new Error('submission never returned a row')
  }
  return row
}

/** Submit a fixture as the `owner` context and wait for it to validate to `ready`; returns the id. */
export async function submitReadyAgent(
  owner: APIRequestContext,
  localPath: string,
  envId: string = ENV_ID,
): Promise<string> {
  const id = await submitLocal(owner, localPath, envId)
  const row = await waitForTerminal(owner, id)
  expect(row.status, JSON.stringify(row.checks)).toBe('ready')
  return id
}

// --- Sessions & ratings --------------------------------------------------------------------------

/**
 * One agent binding on the session-start wire (snake-case `submission_id`).
 */
type AgentAssignment =
  | { kind: 'builtin-agent'; name: string }
  | { kind: 'submission'; submission_id: string }

/**
 * One seat assignment. A wide human seat either names a companion agent for its other members or
 * takes `{ kind: 'self' }`, which puts every member of the seat under the one connected person.
 */
type SeatAssignment =
  | AgentAssignment
  | { kind: 'human'; companion?: AgentAssignment | { kind: 'self' } }

/**
 * The session overrides the start contract carries alongside the seat assignment (Stage 7.4): an
 * explicit episode `seed` (so a deal is reproducible) and a human move-clock `human_timeout_ms`
 * (so a human seat's per-move budget can be tightened from the environment default). Both are optional;
 * omitting one lets the backend pick (a random seed, the environment's `human_timeout_ms`).
 */
interface StartOverrides {
  seed?: number
  humanTimeoutMs?: number
  seasonId?: string
  parameters?: Record<string, boolean | number | string | string[]>
}

/**
 * Start a session from an explicit per-seat assignment, as the `actor` context, and return the new
 * session id. Does not wait for the game to finish; callers that need a rateable recording use
 * {@link finishedScriptedSession}; the render check just needs a started session to watch. The
 * environment must have a play-open season and the actor must be active (`requireActive` gates the
 * start). The optional overrides pin the episode seed (so the deal — and for Hearts the opening 2♣
 * leader is reproducible) and the human move clock.
 */
export async function startSession(
  actor: APIRequestContext,
  envId: string,
  seats: Record<string, SeatAssignment>,
  overrides: StartOverrides = {},
): Promise<string> {
  const prefill = await actor.get(`/api/environments/${envId}/play-parameters`)
  const prefillBody = await prefill.text()
  expect(prefill.status(), prefillBody).toBe(200)
  const play = JSON.parse(prefillBody) as {
    season_id: string | null
    values: Record<string, boolean | number | string | string[]>
  }
  if (play.season_id === null) throw new Error(`${envId} has no play-open season`)
  // Only send the overrides the caller set, so an omitted seed/timeout stays the backend's default
  // rather than a literal `undefined` on the wire.
  const data = {
    env_id: envId,
    season_id: overrides.seasonId ?? play.season_id,
    parameters: overrides.parameters ?? play.values,
    seats,
    ...(overrides.seed !== undefined ? { seed: overrides.seed } : {}),
    ...(overrides.humanTimeoutMs !== undefined
      ? { human_timeout_ms: overrides.humanTimeoutMs }
      : {}),
  }
  let res = await actor.post('/api/sessions', { data })
  // The suite is serial on one shared backend, and a test that fails mid-flight can strand its
  // actor's single active session, which would 409 every later start for the same user until the
  // orphan idles out. Free the named orphan and retry once; a retry that still fails reports the
  // server's reason exactly as a first failure would.
  if (res.status() === 409) {
    let conflict: { code?: string; active_session_id?: string } = {}
    try {
      conflict = JSON.parse(await res.text()) as { code?: string; active_session_id?: string }
    } catch {
      // A non-JSON 409 falls through to the plain status assertion below.
    }
    if (conflict.code === 'already_active' && typeof conflict.active_session_id === 'string') {
      await stopSessionAndAwaitFree(actor, conflict.active_session_id)
      res = await actor.post('/api/sessions', { data })
    }
  }
  expect(res.status(), await res.text()).toBe(201)
  return ((await res.json()) as { id: string }).id
}

export async function getSession(
  actor: APIRequestContext,
  sessionId: string,
): Promise<SessionRow | null> {
  const res = await actor.get(`/api/sessions/${sessionId}`)
  if (!res.ok()) {
    return null
  }
  return (await res.json()) as SessionRow
}

/** Read and parse the first JSONL row from a persisted recording. */
export async function getRecordingHeader(
  actor: APIRequestContext,
  recordingId: string,
): Promise<{ parameters: Record<string, boolean | number | string | string[]> }> {
  const res = await actor.get(`/api/recordings/${recordingId}`)
  const body = await res.text()
  expect(res.status(), body).toBe(200)
  const firstLine = body.split(/\r?\n/, 1)[0]
  if (firstLine === undefined || firstLine === '') throw new Error('recording has no header')
  return JSON.parse(firstLine) as {
    parameters: Record<string, boolean | number | string | string[]>
  }
}

/**
 * Stop a live session as the `owner` context and wait until the backend has freed that user's single
 * active-session reservation, so a following start for the same user cannot race a 409 already-active.
 * Deletes the session, then polls until it reports `ended` (or is already gone). Mirrors
 * {@link finishedScriptedSession}'s stop-then-wait, but returns nothing: the caller only needs the
 * reservation released, not a recording.
 */
export async function stopSessionAndAwaitFree(
  owner: APIRequestContext,
  sessionId: string,
): Promise<void> {
  await owner.delete(`/api/sessions/${sessionId}`).catch(() => {})
  await expect
    .poll(async () => (await getSession(owner, sessionId))?.status ?? 'missing', {
      timeout: 30_000,
      intervals: [500, 1000],
    })
    .toMatch(/ended|missing/)
}

/** The full seat assignment for a scripted watch of one submission, filling the rest with naive. */
function watchSeats(submissionId: string, seatCount: number): Record<string, SeatAssignment> {
  const seats: Record<string, SeatAssignment> = {
    seat_0: { kind: 'submission', submission_id: submissionId },
  }
  for (let i = 1; i < seatCount; i += 1) {
    seats[`seat_${i}`] = { kind: 'builtin-agent', name: 'naive' }
  }
  return seats
}

/**
 * Run a submitted agent in a scripted watch session and drive it to a finalized recording: start it as
 * the `watcher` context, let it come up, stop it (the agent may also end the game on its own first),
 * then wait for the ended state with a recording. The returned session id is rateable. Used to seed the
 * agents' post-session ratings without going through the browser for each. `seatCount` is the
 * environment's seat plan (1 for Flappy Bird; a multi-seat game fills its other seats with the Naive
 * baseline, matching how the arcs schedule a lone submission).
 */
export async function finishedScriptedSession(
  watcher: APIRequestContext,
  submissionId: string,
  envId: string = ENV_ID,
  seatCount = 1,
): Promise<string> {
  const sessionId = await startSession(watcher, envId, watchSeats(submissionId, seatCount))

  // Wait until it is past `starting` so a stop is accepted, then stop it (ignoring the case where the
  // game already ended on its own — the ended-state poll below is the real gate either way).
  await expect
    .poll(async () => (await getSession(watcher, sessionId))?.status ?? 'missing', {
      timeout: 30_000,
      intervals: [500, 1000],
    })
    .not.toBe('starting')
  await watcher.delete(`/api/sessions/${sessionId}`).catch(() => {})

  await expect
    .poll(
      async () => {
        const session = await getSession(watcher, sessionId)
        return session?.status === 'ended' && session.recording_id !== null ? 'ready' : 'waiting'
      },
      { timeout: 60_000, intervals: [500, 1000, 1000] },
    )
    .toBe('ready')
  return sessionId
}

/** Post one rater's 1-5 score (and written comment) for a submitted agent on a finished, rateable
 * session, as `judge`. */
export async function rateSession(
  judge: APIRequestContext,
  sessionId: string,
  submissionId: string,
  score: number,
  feedback: string,
): Promise<void> {
  const res = await judge.post(`/api/sessions/${sessionId}/ratings`, {
    data: {
      ratings: [{ agent: { kind: 'submission', submission_id: submissionId }, score, feedback }],
    },
  })
  expect(res.status(), await res.text()).toBe(200)
}

/** One rater's scheduled vote in the {@link seedRatings} helper. */
export interface SeededRating {
  ctx: APIRequestContext
  score: number
  feedback: string
}

/**
 * Watch `submissionId` in a finished scripted session as `watcher`, then record every rater's vote
 * against that session (all in `envId`'s play-open season). This is the one seed the @slow season
 * arcs share: it turns a built agent into a rateable peer-review target without driving the browser
 * for each rater. How many raters a caller lists decides how full the agent's rating set lands — one
 * rater leaves it well short of the three-distinct-rater rank threshold, the full four-judge set
 * earns it a rank on the Human Ratings board. `seatCount` is the environment's seat plan (see
 * {@link finishedScriptedSession}).
 */
export async function seedRatings(
  watcher: APIRequestContext,
  submissionId: string,
  envId: string,
  raters: SeededRating[],
  seatCount = 1,
): Promise<void> {
  const sessionId = await finishedScriptedSession(watcher, submissionId, envId, seatCount)
  await Promise.all(
    raters.map(({ ctx, score, feedback }) =>
      rateSession(ctx, sessionId, submissionId, score, feedback),
    ),
  )
}

// --- Workflow runs -----------------------------------------------------------------------------

/**
 * Trigger a season's scheduled run through the API and return the new run id. The operator console's
 * "Run workflow" button drives the same endpoint; the demo fixture seed (z-demo-seed) calls it
 * directly so no browser has to be open. The run returns immediately as `pending` and the runner
 * picks it up from the queue.
 */
export async function startSeasonRun(admin: APIRequestContext, seasonId: string): Promise<string> {
  const res = await admin.post(`/api/admin/seasons/${seasonId}/runs`)
  expect(res.status(), await res.text()).toBe(201)
  return ((await res.json()) as { id: string }).id
}

/**
 * Wait for a season's most recent run to leave the in-progress states and return its summary. The
 * runs list is newest first, so its head row is the run {@link startSeasonRun} just triggered. Used
 * by the demo fixture seed to build released seasons without a browser open; the given timeout must
 * cover the scheduled container games, like the arcs' wide per-run windows.
 */
export async function waitForRunTerminal(
  admin: APIRequestContext,
  seasonId: string,
  timeout = 420_000,
): Promise<{ id: string; status: string }> {
  let row: { id: string; status: string } | undefined
  await expect
    .poll(
      async () => {
        const res = await admin.get(`/api/admin/seasons/${seasonId}/runs`)
        expect(res.ok(), await res.text()).toBe(true)
        const runs = (await res.json()) as Array<{ id: string; status: string }>
        row = runs[0]
        return row?.status ?? 'missing'
      },
      { timeout, intervals: [2_000, 5_000, 10_000] },
    )
    .not.toMatch(/pending|running|missing/)
  if (row === undefined) throw new Error('season run never appeared')
  return row
}
