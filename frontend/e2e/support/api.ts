import { type APIRequestContext, expect } from '@playwright/test'

import { ENV_ID } from './names.js'

/**
 * Thin wrappers over the real backend endpoints the specs drive through Playwright's `request`
 * fixture, so each spec composes a flow instead of re-declaring the same fetch-and-assert boilerplate.
 * Every wrapper asserts the status it expects (with the response text on failure, so a broken call
 * reports the server's reason), and operator/identity-scoped calls carry the actor as the
 * `x-sandbox-user` header — the same seam the mock auto-logon uses. A bare call (no header) resolves
 * to `dev-user`, who is the default operator on the e2e backends.
 */

export interface Season {
  id: string
  label: string | null
}

interface SubmissionRow {
  id: string
  status: 'pending' | 'ready' | 'static_failed' | 'build_failed' | 'load_failed'
  checks: { stage: string; status: string; detail: string | null }[]
}

interface SessionRow {
  id: string
  status: 'starting' | 'running' | 'ended'
  recording_id: string | null
}

/** One match design entry, mirroring the backend's MatchConfig codec. */
export interface MatchConfig {
  slots: ('builtin-naive' | 'submission')[]
  seeds: number[]
  games: number
}

function asUser(user: string): { headers: Record<string, string> } {
  return { headers: { 'x-sandbox-user': user } }
}

// --- Seasons -------------------------------------------------------------------------------------

/** Declare a fresh season (unreleased, both windows closed) for an environment (Flappy Bird by default). */
export async function declareSeason(
  request: APIRequestContext,
  label: string,
  envId: string = ENV_ID,
): Promise<Season> {
  const res = await request.post(`/api/admin/environments/${envId}/seasons`, { data: { label } })
  expect(res.status(), await res.text()).toBe(201)
  return (await res.json()) as Season
}

/** Replace a season's whole match design through the typed config endpoint. */
export async function configureMatches(
  request: APIRequestContext,
  seasonId: string,
  matches: MatchConfig[],
  depsVersion = 1,
): Promise<void> {
  const res = await request.put(`/api/admin/seasons/${seasonId}/config`, {
    data: { deps_version: depsVersion, matches },
  })
  expect(res.status(), await res.text()).toBe(200)
}

async function flipWindow(request: APIRequestContext, path: string): Promise<void> {
  const res = await request.post(path)
  expect(res.status(), await res.text()).toBe(200)
}

export const openSubmissions = (request: APIRequestContext, id: string): Promise<void> =>
  flipWindow(request, `/api/admin/seasons/${id}/submissions/open`)
export const closeSubmissions = (request: APIRequestContext, id: string): Promise<void> =>
  flipWindow(request, `/api/admin/seasons/${id}/submissions/close`)
export const openPlay = (request: APIRequestContext, id: string): Promise<void> =>
  flipWindow(request, `/api/admin/seasons/${id}/play/open`)
export const closePlay = (request: APIRequestContext, id: string): Promise<void> =>
  flipWindow(request, `/api/admin/seasons/${id}/play/close`)
export const release = (request: APIRequestContext, id: string): Promise<void> =>
  flipWindow(request, `/api/admin/seasons/${id}/release`)

/** The seasons that currently hold the env's open submission and play windows (the unique-per-env slots). */
export async function activeWindows(
  request: APIRequestContext,
  envId: string = ENV_ID,
): Promise<{ submissionSeasonId: string | null; playSeasonId: string | null }> {
  const res = await request.get(`/api/environments/${envId}/leaderboards`)
  expect(res.ok(), await res.text()).toBe(true)
  const body = (await res.json()) as {
    submission_season_id: string | null
    play_season_id: string | null
  }
  return { submissionSeasonId: body.submission_season_id, playSeasonId: body.play_season_id }
}

/** Set the operator's season-wide rating prompt (display-only guidance shown to every rater). */
export async function setSeasonRatingPrompt(
  request: APIRequestContext,
  seasonId: string,
  prompt: string,
): Promise<void> {
  const res = await request.put(`/api/admin/seasons/${seasonId}/rating-prompt`, {
    data: { prompt },
  })
  expect(res.status(), await res.text()).toBe(200)
}

/** Set an agent author's own rating prompt; the author must have an active submission in the season. */
export async function setAuthorPrompt(
  request: APIRequestContext,
  seasonId: string,
  owner: string,
  prompt: string,
): Promise<void> {
  const res = await request.put(`/api/seasons/${seasonId}/agent-rating-prompt`, {
    ...asUser(owner),
    data: { prompt },
  })
  expect(res.status(), await res.text()).toBe(200)
}

// --- Submissions ---------------------------------------------------------------------------------

/** Submit a local-folder agent under a given owner; returns the pending submission id. */
export async function submitLocal(
  request: APIRequestContext,
  owner: string,
  localPath: string,
  envId: string = ENV_ID,
): Promise<string> {
  const res = await request.post('/api/submissions', {
    ...asUser(owner),
    data: { env_id: envId, local_path: localPath },
  })
  expect(res.status(), await res.text()).toBe(202)
  const body = (await res.json()) as { id: string; status: string }
  expect(body.status).toBe('pending')
  return body.id
}

/** Poll the real validate-and-build pipeline to a terminal status (build and load run containers). */
export async function waitForTerminal(
  request: APIRequestContext,
  id: string,
): Promise<SubmissionRow> {
  let row: SubmissionRow | undefined
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/submissions/${id}`)
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

/** Submit a fixture and wait for it to validate to `ready`; returns the ready submission id. */
export async function submitReadyAgent(
  request: APIRequestContext,
  owner: string,
  localPath: string,
  envId: string = ENV_ID,
): Promise<string> {
  const id = await submitLocal(request, owner, localPath, envId)
  const row = await waitForTerminal(request, id)
  expect(row.status, JSON.stringify(row.checks)).toBe('ready')
  return id
}

// --- Sessions & ratings --------------------------------------------------------------------------

/**
 * One slot's assignment on the session-start wire (snake-case `submission_id`). A discriminated union,
 * so only a `submission` seat carries (and must carry) a `submission_id`; a human or builtin seat has none.
 */
type SlotAssignment =
  | { kind: 'human' | 'builtin-agent' }
  | { kind: 'submission'; submission_id: string }

/**
 * Start a session from an explicit per-slot assignment, as `user`, and return the new session id.
 * Does not wait for the game to finish; callers that need a rateable recording use
 * {@link finishedScriptedSession}; the render check just needs a started session to watch. The
 * environment must have a play-open season and `user` must be allowlisted (the orchestrator gates
 * both before launching a container).
 */
export async function startSession(
  request: APIRequestContext,
  user: string,
  envId: string,
  slots: Record<string, SlotAssignment>,
): Promise<string> {
  const res = await request.post('/api/sessions', {
    ...asUser(user),
    data: { env_id: envId, slots },
  })
  expect(res.status(), await res.text()).toBe(201)
  return ((await res.json()) as { id: string }).id
}

async function getSession(
  request: APIRequestContext,
  sessionId: string,
): Promise<SessionRow | null> {
  const res = await request.get(`/api/sessions/${sessionId}`)
  if (!res.ok()) {
    return null
  }
  return (await res.json()) as SessionRow
}

/**
 * Run a submitted agent in a scripted watch session and drive it to a finalized recording: start it as
 * `watcher`, let it come up, stop it (the agent may also end the game on its own first), then wait for
 * the ended state with a recording. The returned session id is rateable. Used to seed the agents'
 * post-session ratings without going through the browser for each.
 */
export async function finishedScriptedSession(
  request: APIRequestContext,
  watcher: string,
  submissionId: string,
): Promise<string> {
  const res = await request.post('/api/sessions', {
    ...asUser(watcher),
    // The single-seat watch start as a one-slot `slots` assignment (the Stage 7.6 start contract).
    data: {
      env_id: ENV_ID,
      slots: { player_0: { kind: 'submission', submission_id: submissionId } },
    },
  })
  expect(res.status(), await res.text()).toBe(201)
  const sessionId = ((await res.json()) as { id: string }).id

  // Wait until it is past `starting` so a stop is accepted, then stop it (ignoring the case where the
  // game already ended on its own — the ended-state poll below is the real gate either way).
  await expect
    .poll(async () => (await getSession(request, sessionId))?.status ?? 'missing', {
      timeout: 30_000,
      intervals: [500, 1000],
    })
    .not.toBe('starting')
  await request.delete(`/api/sessions/${sessionId}`, asUser(watcher)).catch(() => {})

  await expect
    .poll(
      async () => {
        const session = await getSession(request, sessionId)
        return session?.status === 'ended' && session.recording_id !== null ? 'ready' : 'waiting'
      },
      { timeout: 60_000, intervals: [500, 1000, 1000] },
    )
    .toBe('ready')
  return sessionId
}

/** Post one rater's 1-5 score for a submitted agent on a finished, rateable session. */
export async function rateSession(
  request: APIRequestContext,
  judge: string,
  sessionId: string,
  submissionId: string,
  score: number,
): Promise<void> {
  const res = await request.post(`/api/sessions/${sessionId}/ratings`, {
    ...asUser(judge),
    data: { ratings: [{ agent: { kind: 'submission', submission_id: submissionId }, score }] },
  })
  expect(res.status(), await res.text()).toBe(200)
}
