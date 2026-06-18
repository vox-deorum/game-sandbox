/**
 * Typed wrappers over the backend HTTP routes. Every request carries the identity header from
 * `identity.ts`, so the backend resolves the acting user the same way for fetch and socket.
 *
 * Failures the UI must distinguish come back as typed results, not thrown strings: a non-allowlisted
 * start (403) and an already-active start (409, whose body carries the active session's id so the UI
 * can offer "rejoin"). Everything else throws {@link ApiError}, which the caller renders as a generic
 * problem. The recording fetch and pin calls join here in the replay-and-retention step.
 */

import type { RecordingHeader } from '@game-sandbox/schema'
import { type EnvironmentMeta, isEnvironmentMeta } from '@game-sandbox/schema/environment'

import { identityHeaders } from '../identity.js'

const API_BASE = '/api'

/** A non-typed HTTP failure: a request that did not come back in a shape the UI expects. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...identityHeaders(), ...init.headers },
  })
}

async function json(res: Response, label: string): Promise<unknown> {
  if (!res.ok) {
    throw new ApiError(res.status, `${label} failed with ${res.status}`)
  }
  return res.json()
}

/** Who-am-I and what-may-I-do, the frontend's single source for the allowlist and operator gates. */
export interface Me {
  user_id: string
  allowlisted: boolean
  /** Whether the user may see and drive the operator admin console. The backend gate is the authority. */
  is_operator: boolean
}

/** A persisted session row, as returned by `GET /api/sessions/:id`. */
export interface SessionRow {
  id: string
  user_id: string
  env_id: string
  mode: 'human' | 'scripted'
  status: 'starting' | 'running' | 'ended'
  termination_reason: string | null
  recording_id: string | null
  created_at: string
  ended_at: string | null
}

/**
 * One entry of the merged `GET /api/recordings` listing: the parsed header plus the retention
 * metadata. `user_id`/`created_at` are null for a rowless directory (foreign debris listed
 * header-only); `pinned` reflects the retention row.
 */
export interface RecordingSummary {
  id: string
  header: RecordingHeader
  user_id: string | null
  created_at: string | null
  pinned: boolean
}

/** The fields a start request resolves; the host page fills them from the environment metadata. */
export interface StartSessionInput {
  envId: string
  mode: 'human' | 'scripted'
  seed?: number
  humanSlotTimeoutMs?: number
  /** When set, run this submitted agent in the slot as a watch run sourced from a submission. */
  submissionId?: string
}

/** A started session's id and the socket path the live host attaches to. */
export interface StartedSession {
  id: string
  wsPath: string
}

/** The typed outcome of a start: success, or one of the two failures the UI must react to. */
export type StartSessionResult =
  | { ok: true; session: StartedSession }
  | { ok: false; reason: 'not_allowlisted' }
  | { ok: false; reason: 'already_active'; activeSessionId: string }
  | { ok: false; reason: 'failed'; status: number; message: string }

/** The environment metadata that drives the Home cards and the Environment page. */
export async function getEnvironments(): Promise<EnvironmentMeta[]> {
  const data = await json(await request('/environments'), 'GET /environments')
  if (!Array.isArray(data) || !data.every(isEnvironmentMeta)) {
    throw new ApiError(200, 'environment list has an unexpected shape')
  }
  return data
}

/** The resolved identity and allowlist membership for the auto-logged-on user. */
export async function getMe(): Promise<Me> {
  return (await json(await request('/me'), 'GET /me')) as Me
}

/** Start a live session, mapping the backend's typed 403/409 onto a discriminated result. */
export async function startSession(input: StartSessionInput): Promise<StartSessionResult> {
  const res = await request('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      env_id: input.envId,
      mode: input.mode,
      seed: input.seed,
      human_slot_timeout_ms: input.humanSlotTimeoutMs,
      submission_id: input.submissionId,
    }),
  })
  if (res.status === 201) {
    const body = (await res.json()) as { id: string; ws_path: string }
    return { ok: true, session: { id: body.id, wsPath: body.ws_path } }
  }
  const body = (await res.json().catch(() => ({}))) as {
    code?: string
    error?: string
    active_session_id?: string
  }
  if (res.status === 403 && body.code === 'not_allowlisted') {
    return { ok: false, reason: 'not_allowlisted' }
  }
  if (
    res.status === 409 &&
    body.code === 'already_active' &&
    typeof body.active_session_id === 'string'
  ) {
    return { ok: false, reason: 'already_active', activeSessionId: body.active_session_id }
  }
  return { ok: false, reason: 'failed', status: res.status, message: body.error ?? res.statusText }
}

/** A session row, or `undefined` when no session has that id. */
export async function getSession(id: string): Promise<SessionRow | undefined> {
  const res = await request(`/sessions/${encodeURIComponent(id)}`)
  if (res.status === 404) {
    return undefined
  }
  return (await json(res, 'GET /sessions/:id')) as SessionRow
}

/** Owner-only graceful stop. A 204 (or an already-ended no-op) resolves; other failures throw. */
export async function stopSession(id: string): Promise<void> {
  const res = await request(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 204) {
    throw new ApiError(res.status, `DELETE /sessions/:id failed with ${res.status}`)
  }
}

/** Every readable recording, optionally narrowed to one environment, newest first. */
export async function listRecordings(filter?: { env?: string }): Promise<RecordingSummary[]> {
  const query = filter?.env ? `?env=${encodeURIComponent(filter.env)}` : ''
  return (await json(await request(`/recordings${query}`), 'GET /recordings')) as RecordingSummary[]
}

/** One recording's raw JSONL text, for the replay viewer to parse with the schema reader. */
export async function getRecording(id: string): Promise<string> {
  const res = await request(`/recordings/${encodeURIComponent(id)}`)
  if (!res.ok) {
    throw new ApiError(res.status, `GET /recordings/:id failed with ${res.status}`)
  }
  return res.text()
}

/** The typed outcome of a pin request; the UI distinguishes the pinned-quota refusal. */
export type PinResult =
  | { ok: true }
  | { ok: false; reason: 'pinned_quota' }
  | { ok: false; reason: 'failed'; status: number }

// --- Submissions (Stage 5.5) -----------------------------------------------------------------

/** The validation pipeline's ordered stages, the form renders them as a four-step timeline. */
export type SubmissionStage = 'resolve' | 'static' | 'build' | 'load'
/** A submission's terminal-or-pending rollup status. */
export type SubmissionStatus =
  | 'pending'
  | 'static_failed'
  | 'build_failed'
  | 'load_failed'
  | 'ready'

/** One per-stage validation check, as returned inside the single-submission read. */
export interface SubmissionCheck {
  stage: SubmissionStage
  status: 'running' | 'passed' | 'failed' | 'skipped'
  detail: string | null
  started_at: string
  ended_at: string | null
}

/** A submission joined with its ordered per-stage log: the form's one-request poll payload. */
export interface SubmissionDetail {
  id: string
  iteration_id: string
  env_id: string
  user_id: string
  source_kind: 'git' | 'local'
  repo_url: string | null
  commit_sha: string | null
  local_path: string | null
  ref: string | null
  status: SubmissionStatus
  reason: string | null
  created_at: string
  superseded_at: string | null
  checks: SubmissionCheck[]
}

/** Whether the backend offers the dev-only local-folder source, mirrored into the form's gate. */
export async function getSubmissionCapabilities(): Promise<{ local_submissions: boolean }> {
  return (await json(
    await request('/submissions/capabilities'),
    'GET /submissions/capabilities',
  )) as { local_submissions: boolean }
}

/** The form's source input: a git repo (+ optional ref) or a dev-only local folder path. */
export interface SubmissionSourceInput {
  repoUrl?: string
  ref?: string | null
  localPath?: string
}

/** The reachability pre-check verdict, surfaced inline before the form enables submit. */
export interface ReachabilityResult {
  reachable: boolean
  failure?: string
  detail?: string
}

function sourceBody(input: SubmissionSourceInput): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (input.localPath !== undefined && input.localPath !== '') {
    body.local_path = input.localPath
  } else {
    body.repo_url = input.repoUrl
    if (input.ref !== undefined && input.ref !== null && input.ref !== '') {
      body.ref = input.ref
    }
  }
  return body
}

/** Verify the repo (and ref) reach before accepting; a refused local gate reads as not-reachable. */
export async function checkReachability(input: SubmissionSourceInput): Promise<ReachabilityResult> {
  const res = await request('/submissions/reachability', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sourceBody(input)),
  })
  if (res.ok) {
    return (await res.json()) as ReachabilityResult
  }
  const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string }
  return { reachable: false, failure: body.code ?? 'failed', detail: body.error }
}

/** The typed outcome of a submit: the accepted pending row, or one of the route's typed refusals. */
export type SubmitAgentResult =
  | { ok: true; id: string; status: SubmissionStatus }
  | {
      ok: false
      reason:
        | 'no_open_iteration'
        | 'resubmit_conflict'
        | 'local_disabled'
        | 'invalid_source'
        | 'failed'
      message: string
    }

/** Submit an agent for an environment; identity rides the request header, never the body. */
export async function submitAgent(
  envId: string,
  input: SubmissionSourceInput,
): Promise<SubmitAgentResult> {
  const res = await request('/submissions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ env_id: envId, ...sourceBody(input) }),
  })
  if (res.status === 202) {
    const body = (await res.json()) as { id: string; status: SubmissionStatus }
    return { ok: true, id: body.id, status: body.status }
  }
  const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string }
  return {
    ok: false,
    reason: (body.code ?? 'failed') as Exclude<SubmitAgentResult, { ok: true }>['reason'],
    message: body.error ?? res.statusText,
  }
}

/** Poll a submission's status and per-stage validation log in one request. */
export async function getSubmission(id: string): Promise<SubmissionDetail> {
  return (await json(
    await request(`/submissions/${encodeURIComponent(id)}`),
    'GET /submissions/:id',
  )) as SubmissionDetail
}

/** A submission row without its per-stage log: the shape the play-open listing returns. */
export type SubmissionSummary = Omit<SubmissionDetail, 'checks'>

/**
 * The environment's active submitted agents, optionally narrowed by status. The watch picker reads
 * the `ready` set, so superseded submissions stay profile history rather than watch choices.
 */
export async function listActiveSubmissions(
  envId: string,
  filter?: { status?: SubmissionStatus },
): Promise<SubmissionSummary[]> {
  const query = filter?.status ? `?status=${encodeURIComponent(filter.status)}` : ''
  return (await json(
    await request(`/environments/${encodeURIComponent(envId)}/submissions${query}`),
    'GET /environments/:envId/submissions',
  )) as SubmissionSummary[]
}

/** One submission on the agent profile: its per-stage log plus the recent recordings it ran in. */
export interface AgentProfileSubmission extends SubmissionDetail {
  replays: string[]
}

/** One owner's agent for an environment: submission history (with logs) and recent replays. */
export interface AgentProfile {
  env_id: string
  owner_id: string
  submission_iteration_id: string | null
  play_iteration_id: string | null
  submissions: AgentProfileSubmission[]
}

/** An owner's agent profile for an environment: history across iterations, newest first. */
export async function getAgentProfile(envId: string, ownerId: string): Promise<AgentProfile> {
  return (await json(
    await request(
      `/environments/${encodeURIComponent(envId)}/agents/${encodeURIComponent(ownerId)}`,
    ),
    'GET /environments/:envId/agents/:ownerId',
  )) as AgentProfile
}

/** Pin a recording (owner-only). Maps the backend's 409 `pinned_quota` onto a typed result. */
export async function pinRecording(id: string): Promise<PinResult> {
  const res = await request(`/recordings/${encodeURIComponent(id)}/pin`, { method: 'POST' })
  if (res.status === 204) {
    return { ok: true }
  }
  const body = (await res.json().catch(() => ({}))) as { code?: string }
  if (res.status === 409 && body.code === 'pinned_quota') {
    return { ok: false, reason: 'pinned_quota' }
  }
  return { ok: false, reason: 'failed', status: res.status }
}

/** Unpin a recording (owner-only). A 204 resolves; other failures come back as a typed result. */
export async function unpinRecording(id: string): Promise<PinResult> {
  const res = await request(`/recordings/${encodeURIComponent(id)}/pin`, { method: 'DELETE' })
  if (res.status === 204) {
    return { ok: true }
  }
  return { ok: false, reason: 'failed', status: res.status }
}

// --- Ratings and the author prompt (Stage 6.6) -----------------------------------------------

/** The agent identity as it travels on the wire: no `user_id`, which the backend resolves itself. */
export type AgentRefWire = { kind: 'submission'; submission_id: string } | { kind: 'builtin-naive' }

/** One rateable agent in a session, as the rating read/write returns it. */
export interface RateableAgent {
  agent: AgentRefWire
  /** True when the caller owns this submitted agent: the UI shows it without a rating control. */
  is_own: boolean
  /** The agent author's prompt for this iteration, when set (null for the ownerless Naive baseline). */
  author_prompt: string | null
  /** The caller's current effective rating, or null when they have not rated this agent. */
  your_rating: number | null
}

/** The rating read/write payload for one session: the iteration prompt and the per-agent view. */
export interface SessionRatings {
  session_id: string
  iteration_id: string
  /** True when the iteration's play window is closed: prior ratings show, but no new write is taken. */
  read_only: boolean
  /** The operator's iteration-wide rating prompt, applying to every agent (null when unset). */
  iteration_prompt: string | null
  agents: RateableAgent[]
}

/**
 * Reading a finished session's ratings: the view, or a reason it is not rateable. An old session with
 * no iteration and one without a finalized recording both come back unrateable, so the post-session UI
 * simply renders nothing rather than an error.
 */
export type SessionRatingsResult =
  | { ok: true; ratings: SessionRatings }
  | { ok: false; reason: 'not_rateable' | 'not_finished' | 'failed' }

/** Read the caller's existing ratings and the two applicable prompts for a finished session's agents. */
export async function getSessionRatings(sessionId: string): Promise<SessionRatingsResult> {
  const res = await request(`/sessions/${encodeURIComponent(sessionId)}/ratings`)
  if (res.ok) {
    return { ok: true, ratings: (await res.json()) as SessionRatings }
  }
  const body = (await res.json().catch(() => ({}))) as { code?: string }
  return { ok: false, reason: rateabilityReason(body.code) }
}

/** Submitting (or overwriting) ratings: the saved view, or a typed refusal the UI surfaces inline. */
export type SubmitRatingsResult =
  | { ok: true; ratings: SessionRatings }
  | { ok: false; reason: 'play_closed' | 'not_rateable' | 'not_finished' | 'invalid' | 'failed' }

/** Submit a batch of `{ agent, score }` ratings for a session. The whole batch saves or none does. */
export async function submitRatings(
  sessionId: string,
  ratings: ReadonlyArray<{ agent: AgentRefWire; score: number }>,
): Promise<SubmitRatingsResult> {
  const res = await request(`/sessions/${encodeURIComponent(sessionId)}/ratings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ratings }),
  })
  if (res.ok) {
    return { ok: true, ratings: (await res.json()) as SessionRatings }
  }
  const body = (await res.json().catch(() => ({}))) as { code?: string }
  if (body.code === 'play_closed') {
    return { ok: false, reason: 'play_closed' }
  }
  if (body.code === 'session_not_rateable') {
    return { ok: false, reason: 'not_rateable' }
  }
  if (body.code === 'session_not_finished') {
    return { ok: false, reason: 'not_finished' }
  }
  if (res.status === 400) {
    return { ok: false, reason: 'invalid' }
  }
  return { ok: false, reason: 'failed' }
}

/** Map the read endpoint's conflict code onto the reason the UI branches on. */
function rateabilityReason(code: string | undefined): 'not_rateable' | 'not_finished' | 'failed' {
  if (code === 'session_not_rateable') {
    return 'not_rateable'
  }
  if (code === 'session_not_finished') {
    return 'not_finished'
  }
  return 'failed'
}

/** The author's per-iteration rating prompt, as the get/set routes return it (null when unset). */
export interface AuthorPrompt {
  iteration_id: string
  prompt: string | null
}

/** Read the caller's own rating prompt for an iteration, to populate the agent-profile editor. */
export async function getAuthorPrompt(iterationId: string): Promise<AuthorPrompt> {
  return (await json(
    await request(`/iterations/${encodeURIComponent(iterationId)}/agent-rating-prompt`),
    'GET /iterations/:iterationId/agent-rating-prompt',
  )) as AuthorPrompt
}

/** Setting (or clearing) the author prompt: the saved value, or a typed refusal. */
export type SetAuthorPromptResult =
  | { ok: true; prompt: string | null }
  | { ok: false; reason: 'no_agent_in_iteration' | 'too_long' | 'failed' }

/** Set or clear the caller's rating prompt for an iteration. A null or empty prompt clears it. */
export async function setAuthorPrompt(
  iterationId: string,
  prompt: string | null,
): Promise<SetAuthorPromptResult> {
  const res = await request(`/iterations/${encodeURIComponent(iterationId)}/agent-rating-prompt`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })
  if (res.ok) {
    const body = (await res.json()) as AuthorPrompt
    return { ok: true, prompt: body.prompt }
  }
  const body = (await res.json().catch(() => ({}))) as { code?: string }
  if (body.code === 'no_agent_in_iteration') {
    return { ok: false, reason: 'no_agent_in_iteration' }
  }
  if (body.code === 'author_prompt_too_long') {
    return { ok: false, reason: 'too_long' }
  }
  return { ok: false, reason: 'failed' }
}

// --- Iterations, boards, and the admin console (Stage 6.7) -----------------------------------

/**
 * An agent identity as the boards, placements, and scheduled slots carry it. Unlike {@link AgentRefWire}
 * (the rating write shape, which omits `user_id` for the backend to resolve), a board row carries the
 * `user_id` so the UI can link a submitted-agent row to its profile. The Naive baseline has no owner.
 */
export type BoardAgentRef =
  | { kind: 'submission'; submission_id: string; user_id: string }
  | { kind: 'builtin-naive' }

/** A public gate's two-valued state, mirrored from the backend's `WindowStatus`. */
export type WindowStatus = 'open' | 'closed'
/** Whether an iteration's results are shown outside the operator console. */
export type ReleaseStatus = 'unreleased' | 'released'
/** One automated run's lifecycle state. */
export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
/** One scheduled match's lifecycle state. */
export type GameStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled'

/** One seat in a match composition: the built-in scripted baseline, or a participant submission. */
export type SlotSpec = 'builtin-naive' | 'submission'

/** One match configuration: its seat composition, the seeds every game runs, and the game count. */
export interface MatchConfig {
  slots: SlotSpec[]
  seeds: number[]
  games: number
}

/**
 * The override block. `step_timeout_ms`/`episode_timeout_ms` take effect this stage; `messaging` and
 * `llm` are parsed-but-inert opaque objects until Stages 8/9 give them a concrete shape.
 */
export interface IterationOverrides {
  step_timeout_ms?: number
  episode_timeout_ms?: number
  messaging?: Record<string, unknown>
  llm?: Record<string, unknown>
}

/** The whole iteration configuration document (the `iterations.config` JSON, decoded). */
export interface IterationConfig {
  deps_version: number
  matches: MatchConfig[]
  overrides?: IterationOverrides
}

/** An iteration row with its `config` JSON decoded: the shape both the admin and public reads return. */
export interface IterationView {
  id: string
  env_id: string
  submission_status: WindowStatus
  play_status: WindowStatus
  release_status: ReleaseStatus
  label: string | null
  config: IterationConfig
  rating_prompt: string | null
  created_at: string
  released_at: string | null
}

/** One automated-board row: a per-agent aggregate over the latest completed run's results. */
export interface AutomatedBoardRow {
  agent: BoardAgentRef
  mean_score: number
  /** Weighted mean per-decision agent compute time; null when no tick contributed. */
  mean_agent_compute_ms: number | null
  failure_count: number
  games: number
  /** The representative replay link (the agent's best game), or null. */
  recording_id: string | null
}

/** One human-feedback-board row: mean rating and count, with the ranking applied (null when unranked). */
export interface HumanBoardRow {
  agent: BoardAgentRef
  mean: number
  count: number
  rank: number | null
}

/** Both boards for an iteration: the automated aggregate and the human-rating aggregate. */
export interface Board {
  automated: AutomatedBoardRow[]
  human: HumanBoardRow[]
}

/** One scheduled game with its resolved seats decoded; the run panel shows per-game status. */
export interface RunGameView {
  id: string
  run_id: string
  match_index: number
  game_index: number
  seed: number
  slots: BoardAgentRef[]
  status: GameStatus
  recording_id: string | null
  started_at: string | null
  ended_at: string | null
  error: string | null
}

/** A run with its frozen snapshots decoded and its scheduled games attached (the admin status view). */
export interface RunView {
  id: string
  iteration_id: string
  requested_by: string
  config_snapshot: IterationConfig
  submission_snapshot: BoardAgentRef[]
  status: RunStatus
  started_at: string
  ended_at: string | null
  error: string | null
  games: RunGameView[]
}

/** The full admin view of one iteration: its config and gates, the latest run, and both boards. */
export interface AdminIterationView {
  iteration: IterationView
  latest_run: RunView | null
  board: Board
}

/** The current released iteration plus its boards, as the environment leaderboards read returns it. */
export interface CurrentLeaderboards {
  iteration: IterationView
  board: Board
}

/**
 * The environment leaderboards payload: the current released boards (or null when nothing is released),
 * plus the separate public submit and play targets, reported even when their iterations are unreleased.
 */
export interface EnvironmentLeaderboards {
  current: CurrentLeaderboards | null
  submission_iteration_id: string | null
  play_iteration_id: string | null
}

/** One automated placement on an agent profile, read from the public placements route. */
export interface AutomatedPlacement {
  id: string
  iteration_id: string
  env_id: string
  run_id: string
  rank: number
  agent_kind: 'submission' | 'builtin-naive'
  agent_submission_id: string | null
  agent_user_id: string | null
  mean_score: number
  mean_agent_compute_ms: number | null
  failure_count: number
  recording_id: string | null
  created_at: string
}

/** An agent's released placements for an environment, newest first, for the profile page. */
export interface AgentPlacements {
  env_id: string
  owner_id: string
  placements: AutomatedPlacement[]
}

// --- Public, released-only reads -------------------------------------------------------------

/** The current released iteration's boards plus the separate public submit and play targets. */
export async function getEnvironmentLeaderboards(envId: string): Promise<EnvironmentLeaderboards> {
  return (await json(
    await request(`/environments/${encodeURIComponent(envId)}/leaderboards`),
    'GET /environments/:envId/leaderboards',
  )) as EnvironmentLeaderboards
}

/** The environment's released iterations, newest first, for the history links. */
export async function listReleasedIterations(envId: string): Promise<IterationView[]> {
  return (await json(
    await request(`/environments/${encodeURIComponent(envId)}/iterations`),
    'GET /environments/:envId/iterations',
  )) as IterationView[]
}

/**
 * Both boards for a specific released iteration. Returns `undefined` for an unreleased or unknown
 * iteration, which the public route answers with 404 — the boundary that keeps unreleased boards private.
 */
export async function getIterationLeaderboards(
  envId: string,
  iterationId: string,
): Promise<CurrentLeaderboards | undefined> {
  const res = await request(
    `/environments/${encodeURIComponent(envId)}/iterations/${encodeURIComponent(iterationId)}/leaderboards`,
  )
  if (res.status === 404) {
    return undefined
  }
  return (await json(
    res,
    'GET /environments/:envId/iterations/:iterationId/leaderboards',
  )) as CurrentLeaderboards
}

/** An agent's released automated placements for the profile page. */
export async function getAgentPlacements(envId: string, ownerId: string): Promise<AgentPlacements> {
  return (await json(
    await request(
      `/environments/${encodeURIComponent(envId)}/agents/${encodeURIComponent(ownerId)}/placements`,
    ),
    'GET /environments/:envId/agents/:ownerId/placements',
  )) as AgentPlacements
}

// --- Operator admin console (gated server-side under /api/admin) ------------------------------

/** Every iteration for the environment, including unreleased ones, for the console picker. */
export async function listAdminIterations(envId: string): Promise<IterationView[]> {
  return (await json(
    await request(`/admin/environments/${encodeURIComponent(envId)}/iterations`),
    'GET /api/admin/environments/:envId/iterations',
  )) as IterationView[]
}

/** The full admin view of one iteration: config, gates, latest run, and both (possibly unreleased) boards. */
export async function getAdminIteration(iterationId: string): Promise<AdminIterationView> {
  return (await json(
    await request(`/admin/iterations/${encodeURIComponent(iterationId)}`),
    'GET /api/admin/iterations/:id',
  )) as AdminIterationView
}

/** Declare a new unreleased, submission-closed, play-closed iteration for the environment. */
export async function declareIteration(
  envId: string,
  input: { label?: string | null; depsVersion?: number } = {},
): Promise<IterationView> {
  const body: Record<string, unknown> = {}
  if (input.label !== undefined) body.label = input.label
  if (input.depsVersion !== undefined) body.deps_version = input.depsVersion
  const res = await request(`/admin/environments/${encodeURIComponent(envId)}/iterations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await json(res, 'POST /api/admin/environments/:envId/iterations')) as IterationView
}

/**
 * The outcome of replacing an iteration's config. An unforced edit against existing runs (or a
 * `deps_version` change against existing submissions) is refused; the console re-sends with `force`
 * after the confirmation dialog. An invalid config carries the backend's specific reason.
 */
export type ConfigureIterationResult =
  | { ok: true; iteration: IterationView }
  | {
      ok: false
      reason: 'iteration_has_runs' | 'iteration_has_submissions' | 'invalid_config' | 'failed'
      message: string
    }

/** Replace an iteration's whole config. `force` carries the destructive-edit confirmation. */
export async function configureIteration(
  iterationId: string,
  config: IterationConfig,
  force = false,
): Promise<ConfigureIterationResult> {
  const query = force ? '?force=true' : ''
  const res = await request(`/admin/iterations/${encodeURIComponent(iterationId)}/config${query}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  })
  if (res.ok) {
    return { ok: true, iteration: (await res.json()) as IterationView }
  }
  const body = (await res.json().catch(() => ({}))) as {
    code?: string
    reason?: string
    error?: string
  }
  const reason =
    body.code === 'iteration_has_runs' ||
    body.code === 'iteration_has_submissions' ||
    body.code === 'invalid_config'
      ? body.code
      : 'failed'
  return { ok: false, reason, message: body.reason ?? body.error ?? res.statusText }
}

/** The outcome of setting the operator's iteration-wide rating prompt; an overlong prompt is typed. */
export type SetIterationRatingPromptResult =
  | { ok: true; iteration: IterationView }
  | { ok: false; reason: 'too_long' | 'failed' }

/** Set or clear the operator's always-editable iteration rating prompt. */
export async function setIterationRatingPrompt(
  iterationId: string,
  prompt: string | null,
): Promise<SetIterationRatingPromptResult> {
  const res = await request(`/admin/iterations/${encodeURIComponent(iterationId)}/rating-prompt`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })
  if (res.ok) {
    return { ok: true, iteration: (await res.json()) as IterationView }
  }
  const body = (await res.json().catch(() => ({}))) as { code?: string }
  if (body.code === 'rating_prompt_too_long') {
    return { ok: false, reason: 'too_long' }
  }
  return { ok: false, reason: 'failed' }
}

/** The outcome of opening the submission window: a typed conflict when another iteration is open. */
export type OpenSubmissionsResult =
  | { ok: true; iteration: IterationView }
  | { ok: false; reason: 'open_iteration_exists' | 'failed' }

/** Open the submission window. The one-open-submission invariant surfaces as `open_iteration_exists`. */
export async function openSubmissions(iterationId: string): Promise<OpenSubmissionsResult> {
  const res = await request(
    `/admin/iterations/${encodeURIComponent(iterationId)}/submissions/open`,
    { method: 'POST' },
  )
  if (res.ok) {
    return { ok: true, iteration: (await res.json()) as IterationView }
  }
  const body = (await res.json().catch(() => ({}))) as { code?: string }
  return {
    ok: false,
    reason: body.code === 'open_iteration_exists' ? 'open_iteration_exists' : 'failed',
  }
}

/** Close the submission window. */
export async function closeSubmissions(iterationId: string): Promise<IterationView> {
  return (await json(
    await request(`/admin/iterations/${encodeURIComponent(iterationId)}/submissions/close`, {
      method: 'POST',
    }),
    'POST /api/admin/iterations/:id/submissions/close',
  )) as IterationView
}

/** The outcome of opening public play: a typed conflict when another iteration is already play-open. */
export type OpenPlayResult =
  | { ok: true; iteration: IterationView }
  | { ok: false; reason: 'open_play_iteration_exists' | 'failed' }

/** Open the public-play window. The one-play-open invariant surfaces as `open_play_iteration_exists`. */
export async function openPlay(iterationId: string): Promise<OpenPlayResult> {
  const res = await request(`/admin/iterations/${encodeURIComponent(iterationId)}/play/open`, {
    method: 'POST',
  })
  if (res.ok) {
    return { ok: true, iteration: (await res.json()) as IterationView }
  }
  const body = (await res.json().catch(() => ({}))) as { code?: string }
  return {
    ok: false,
    reason: body.code === 'open_play_iteration_exists' ? 'open_play_iteration_exists' : 'failed',
  }
}

/** Close the public-play window. */
export async function closePlay(iterationId: string): Promise<IterationView> {
  return (await json(
    await request(`/admin/iterations/${encodeURIComponent(iterationId)}/play/close`, {
      method: 'POST',
    }),
    'POST /api/admin/iterations/:id/play/close',
  )) as IterationView
}

/** Release the iteration's results, exposing its boards on the environment page. */
export async function releaseIteration(iterationId: string): Promise<IterationView> {
  return (await json(
    await request(`/admin/iterations/${encodeURIComponent(iterationId)}/release`, {
      method: 'POST',
    }),
    'POST /api/admin/iterations/:id/release',
  )) as IterationView
}

/** Pull the iteration's results back to operator-only. */
export async function unreleaseIteration(iterationId: string): Promise<IterationView> {
  return (await json(
    await request(`/admin/iterations/${encodeURIComponent(iterationId)}/unrelease`, {
      method: 'POST',
    }),
    'POST /api/admin/iterations/:id/unrelease',
  )) as IterationView
}

/** The outcome of triggering a run: the new run id, or a typed refusal the console surfaces. */
export type TriggerRunResult =
  | { ok: true; id: string; status: RunStatus }
  | { ok: false; reason: 'run_in_progress' | 'empty_schedule' | 'failed'; message: string }

/** Trigger (or re-run) the workflow. Non-blocking; returns the new run id immediately. */
export async function triggerRun(iterationId: string): Promise<TriggerRunResult> {
  const res = await request(`/admin/iterations/${encodeURIComponent(iterationId)}/runs`, {
    method: 'POST',
  })
  if (res.status === 201) {
    const body = (await res.json()) as { id: string; status: RunStatus }
    return { ok: true, id: body.id, status: body.status }
  }
  const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string }
  const reason =
    body.code === 'run_in_progress' || body.code === 'empty_schedule' ? body.code : 'failed'
  return { ok: false, reason, message: body.error ?? res.statusText }
}

/** The outcome of a cancel request: accepted, or a typed refusal for an already-terminal run. */
export type CancelRunResult = { ok: true } | { ok: false; reason: 'run_not_in_progress' | 'failed' }

/** Request cancellation of an in-progress run. */
export async function cancelRun(iterationId: string, runId: string): Promise<CancelRunResult> {
  const res = await request(
    `/admin/iterations/${encodeURIComponent(iterationId)}/runs/${encodeURIComponent(runId)}/cancel`,
    { method: 'POST' },
  )
  if (res.ok) {
    return { ok: true }
  }
  const body = (await res.json().catch(() => ({}))) as { code?: string }
  return {
    ok: false,
    reason: body.code === 'run_not_in_progress' ? 'run_not_in_progress' : 'failed',
  }
}

/** The path of the admin run-log WebSocket the {@link RunLogSocket} attaches to. */
export function runLogWsPath(iterationId: string, runId: string): string {
  return `/api/admin/iterations/${encodeURIComponent(iterationId)}/runs/${encodeURIComponent(runId)}/logs/ws`
}
