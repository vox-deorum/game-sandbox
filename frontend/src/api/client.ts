/**
 * Typed wrappers over the backend HTTP routes. Same-origin fetches carry the Better Auth session
 * cookie automatically, so these wrappers send no identity header; the backend resolves the acting
 * user from that cookie the same way for a fetch, a WebSocket upgrade, and a download navigation.
 *
 * Failures the UI must distinguish come back as typed results, not thrown strings: a non-active start
 * (403) and an already-active start (409, whose body carries the active session's id so the UI can
 * offer "rejoin"). A 401 whose body carries code `auth_required` — a session revoked or expired
 * mid-use — bounces the browser to `/login` from the one {@link request} choke point. Everything else
 * throws {@link ApiError}, which the caller renders as a generic problem.
 */

import type { RecordingHeader } from '@game-sandbox/schema'
import type { BoardAgentRef } from '@game-sandbox/schema/board'
import {
  type EnvironmentMeta,
  isEnvironmentMeta,
  type ParameterValue,
} from '@game-sandbox/schema/environment'
import type {
  ModelAlias,
  LlmModelUsage as SchemaLlmModelUsage,
  LlmUsageByModel as SchemaLlmUsageByModel,
} from '@game-sandbox/schema/llm'

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
  const res = await fetch(`${API_BASE}${path}`, init)
  // The one identity choke point (it used to inject the identity header): a session banned or expired
  // mid-use comes back as a 401 carrying code `auth_required`. Bounce to sign-in so the next action
  // does not silently fail — but never from `/login` itself, and never for a page that browses
  // anonymously on purpose, which gates on `/api/me` before issuing any protected request and so
  // never reaches this branch.
  if (res.status === 401 && window.location.pathname !== '/login') {
    const body = (await res
      .clone()
      .json()
      .catch(() => ({}))) as { code?: string }
    if (body.code === 'auth_required') {
      window.location.assign('/login')
    }
  }
  return res
}

async function json(res: Response, label: string): Promise<unknown> {
  if (!res.ok) {
    throw new ApiError(res.status, `${label} failed with ${res.status}`)
  }
  return res.json()
}

/** A user's derived participation status: `pending` before approval, `normal`, or `admin`. */
export type UserStatus = 'pending' | 'normal' | 'admin'

/** The signed-in session user as `/api/me` returns it: identity, profile fields, and derived status. */
export interface MeUser {
  id: string
  name: string
  email: string
  image: string | null
  /** The connected GitHub account's snapshotted handle, or null when GitHub is not linked. */
  github_username: string | null
  status: UserStatus
}

/**
 * Who-am-I: the session user, or `null` for an anonymous visitor. Capabilities derive from `status`
 * through {@link canParticipate} and {@link isAdmin} (in `me.ts`); the backend gate is the authority.
 */
export interface Me {
  user: MeUser | null
}

/** A persisted session row, as returned by `GET /api/sessions/:id`. */
export interface SessionRow {
  id: string
  user_id: string
  /** The owner's display name, when the directory has one; absent falls back to `user_id`. */
  user_name?: string
  env_id: string
  mode: 'human' | 'scripted'
  status: 'starting' | 'running' | 'ended'
  termination_reason: string | null
  recording_id: string | null
  /** The competition season this session belongs to; null only for non-competitive legacy rows. */
  season_id: string | null
  /** The complete normalized gameplay parameter map this session launched with. */
  parameters: Record<string, ParameterValue>
  /**
   * The resolved per-move budget (ms) for the connected human seat: the session's override or the
   * environment default. The session page shows the move clock from this rather than the env-default
   * metadata. Null for a scripted watch (no human seat) or an env with no human timeout.
   */
  human_timeout_ms: number | null
  /**
   * The session's resolved effective messaging rules, persisted on the row so live and reopened-ended
   * payloads agree. `messaging_enabled` is a SQLite 0/1 (treat as truthy); `message_cap` is the
   * effective code-point cap, or null for no cap. The Stage 8 chat panel mounts when messaging is
   * enabled and counts down from `message_cap`.
   */
  messaging_enabled: number
  message_cap: number | null
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
  /** The owner's display name, when the directory has one; absent falls back to `user_id`. */
  user_name?: string
  created_at: string | null
  pinned: boolean
  /** How the producing session ended, so the replay viewer can label its outcome; null when unknown. */
  termination_reason: string | null
  /** The winning seat id (`seat_0`, `seat_1`, ...), -1 for a tie, or null without a result. */
  winner_id?: string | -1 | null
  /** The season the producing session competed in; null when no session claims the recording. */
  season_id: string | null
}

/**
 * One seat's assignment as the start flow builds it: a connected human, the built-in Naive baseline,
 * or a named submitted agent. The discriminated union carries `submissionId` only on a `submission`
 * seat; {@link startSession} maps it to the wire's snake-case `submission_id`. Mirrors the backend
 * `SeatAssignment`, so the frontend payload is honest at the trust boundary.
 */
export type AgentAssignmentInput =
  | { kind: 'builtin-agent' }
  | { kind: 'submission'; submissionId: string }

/** One assignable seat, including the companion seam used when a later stage adds wide seats. */
export type SeatAssignmentInput =
  | AgentAssignmentInput
  | { kind: 'human'; companion?: AgentAssignmentInput }

/**
 * The fields a start request resolves; the seat-assignment flow fills them from the environment
 * metadata. The session is an explicit per-seat assignment keyed by seat id: the
 * backend derives the human-versus-scripted `mode` from it, so no `mode` is sent.
 */
export interface StartSessionInput {
  envId: string
  seasonId: string
  parameters: Record<string, ParameterValue>
  seed?: number
  humanTimeoutMs?: number
  /** Per-seat assignment keyed by seat id; must cover exactly the resolved layout's seats. */
  seats: Record<string, SeatAssignmentInput>
}

/**
 * A start request minus the environment it targets: what a seat-assignment dialog resolves (the
 * `seats` assignment plus the session overrides), to be spread into {@link startSession} alongside the
 * page's `envId`. Keeping the dialog payload and the API input the same shape removes a layer of
 * per-flow wrapper objects.
 */
export type StartPayload = Omit<StartSessionInput, 'envId'>

/** The complete parameter state a play-open season exposes to public start forms. */
export interface PlayParameters {
  season_id: string | null
  values: Record<string, ParameterValue>
}

/** A started session's id and the socket path the live host attaches to. */
export interface StartedSession {
  id: string
  wsPath: string
}

/** The typed outcome of a start: success, or one of the two failures the UI must react to. */
export type StartSessionResult =
  | { ok: true; session: StartedSession }
  | { ok: false; reason: 'not_active' }
  | { ok: false; reason: 'already_active'; activeSessionId: string }
  | { ok: false; reason: 'play_season_changed' }
  | { ok: false; reason: 'invalid_parameters' }
  | { ok: false; reason: 'failed'; status: number; message: string }

/** The environment metadata that drives the Home cards and the Environment page. */
export async function getEnvironments(): Promise<EnvironmentMeta[]> {
  const data = await json(await request('/environments'), 'GET /environments')
  if (!Array.isArray(data) || !data.every(isEnvironmentMeta)) {
    throw new ApiError(200, 'environment list has an unexpected shape')
  }
  return data
}

/** Load the season id and complete resolved parameter map that a start request must echo. */
export async function getPlayParameters(envId: string): Promise<PlayParameters> {
  return (await json(
    await request(`/environments/${encodeURIComponent(envId)}/play-parameters`),
    `GET /environments/${envId}/play-parameters`,
  )) as PlayParameters
}

/** The signed-in session user and derived status, or `{ user: null }` for an anonymous visitor. */
export async function getMe(): Promise<Me> {
  return (await json(await request('/me'), 'GET /me')) as Me
}

/** Public deployment branding, read once at startup to drive the sidebar brand and the document title. */
export interface SiteConfig {
  site_name: string
  /** A compact brand for space-sensitive chrome; equals `site_name` unless `SITE_SHORT_NAME` is set. */
  site_short_name: string
  /** Whether the deployment enabled GitHub OAuth, so the login page shows the GitHub sign-in button. */
  github_auth: boolean
}

/** The deployment's public branding config (its `SITE_NAME`), served unauthenticated. */
export async function getSiteConfig(): Promise<SiteConfig> {
  return (await json(await request('/config'), 'GET /config')) as SiteConfig
}

/** One navigation entry in the documentation area: a page, or a section carrying child pages. */
export interface DocsNavEntry {
  /** The docs-relative source path including `.md`, the key a page fetch and route mapping use. */
  path: string
  title: string
  children?: DocsNavEntry[]
}

/** The documentation navigation tree; the landing page is served separately by {@link getDocsIndex}. */
export interface DocsManifest {
  pages: DocsNavEntry[]
}

/** One documentation page: its raw markdown and the docs-relative path links resolve against. */
export interface DocsPage {
  path: string
  content: string
}

/** The student-guide navigation tree the Documentation page renders as its sidebar. */
export async function getDocsManifest(): Promise<DocsManifest> {
  return (await json(await request('/docs/manifest'), 'GET /docs/manifest')) as DocsManifest
}

/** The documentation landing page (the students index, or a deployment's class-index override). */
export async function getDocsIndex(): Promise<DocsPage> {
  return (await json(await request('/docs/index'), 'GET /docs/index')) as DocsPage
}

/** One documentation page's markdown by its docs-relative `path` (e.g. `students/submitting.md`). */
export async function getDocsPage(path: string): Promise<DocsPage> {
  // Encode each segment so a filename with a space or reserved character survives the URL; the `/`
  // separators stay literal and Fastify decodes the wildcard back to the docs-relative path.
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return (await json(
    await request(`/docs/pages/${encoded}`),
    `GET /docs/pages/${path}`,
  )) as DocsPage
}

/**
 * Map one agent binding onto the wire shape: snake-case `submission_id`, present only for a
 * submission binding.
 */
function toAgentBody(assignment: AgentAssignmentInput): Record<string, unknown> {
  return assignment.kind === 'submission'
    ? { kind: 'submission', submission_id: assignment.submissionId }
    : { kind: assignment.kind }
}

/** Map one seat assignment onto the backend wire shape. */
function toSeatBody(assignment: SeatAssignmentInput): Record<string, unknown> {
  if (assignment.kind !== 'human') {
    return toAgentBody(assignment)
  }
  return {
    kind: 'human',
    ...(assignment.companion === undefined ? {} : { companion: toAgentBody(assignment.companion) }),
  }
}

/** Start a live session, mapping the backend's typed 403/409 onto a discriminated result. */
export async function startSession(input: StartSessionInput): Promise<StartSessionResult> {
  const res = await request('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      env_id: input.envId,
      season_id: input.seasonId,
      parameters: input.parameters,
      seed: input.seed,
      human_timeout_ms: input.humanTimeoutMs,
      seats: Object.fromEntries(
        Object.entries(input.seats).map(([seatId, assignment]) => [seatId, toSeatBody(assignment)]),
      ),
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
  if (res.status === 403 && body.code === 'not_active') {
    return { ok: false, reason: 'not_active' }
  }
  if (
    res.status === 409 &&
    body.code === 'already_active' &&
    typeof body.active_session_id === 'string'
  ) {
    return { ok: false, reason: 'already_active', activeSessionId: body.active_session_id }
  }
  if (res.status === 409 && body.code === 'play_season_changed') {
    return { ok: false, reason: 'play_season_changed' }
  }
  if (res.status === 400 && body.code === 'invalid_parameters') {
    return { ok: false, reason: 'invalid_parameters' }
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

/** Public metadata for one successful official model call, with bodies only when authorized. */
export interface RecordingLlmCall {
  tick: number | null
  player: string
  model: string
  input_tokens: number
  reasoning_tokens: number
  output_tokens: number
  usage_estimated: boolean
  cost_weight: number
  budget_cost_units: number
  request?: unknown
  completion?: unknown
}

/** Successful recording telemetry, including the authoritative stored whole-recording cost. */
export interface RecordingLlmTelemetry {
  calls: RecordingLlmCall[]
  total_budget_cost_units: number
}

/** Broken retained telemetry is distinct from a valid recording with no successful calls. */
export type RecordingLlmResult =
  | { ok: true; telemetry: RecordingLlmTelemetry }
  | { ok: false; reason: 'telemetry_unavailable' }

/** Read official calls without turning broken retained data into a valid empty result. */
export async function getRecordingLlm(id: string): Promise<RecordingLlmResult> {
  const res = await request(`/recordings/${encodeURIComponent(id)}/llm`)
  if (res.status === 500) {
    const body = (await res
      .clone()
      .json()
      .catch(() => ({}))) as { code?: string }
    if (body.code === 'telemetry_unavailable') {
      return { ok: false, reason: 'telemetry_unavailable' }
    }
  }
  return {
    ok: true,
    telemetry: (await json(res, 'GET /recordings/:id/llm')) as RecordingLlmTelemetry,
  }
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
  season_id: string
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
        | 'no_open_season'
        | 'resubmit_conflict'
        | 'local_disabled'
        | 'invalid_source'
        | 'failed'
      message: string
    }

/** Submit an agent for an environment; the session cookie carries identity, never the body. */
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

/** One viewer-specific submitted-agent choice in the play-open season's watch/rating list. */
export interface WatchAgentSummary {
  submission_id: string
  anonymous_number: number
  rating_status: 'unrated' | 'rated' | 'own'
  /** Operator-only identity and source fields; absent from regular-user responses. */
  owner_id?: string
  /** The owner's display name, when the directory has one; absent falls back to `owner_id`. */
  owner_name?: string
  source_kind?: 'git' | 'local'
  repo_url?: string | null
  commit_sha?: string | null
  local_path?: string | null
  ref?: string | null
}

/** The play-open season's viewer-specific watch choices, redacted for non-operators. */
export async function listWatchAgents(envId: string): Promise<WatchAgentSummary[]> {
  return (await json(
    await request(`/environments/${encodeURIComponent(envId)}/watch-agents`),
    'GET /environments/:envId/watch-agents',
  )) as WatchAgentSummary[]
}

/**
 * The env's play-open anonymous numbering as a submission-id → number map. This is the same
 * season-wide sequence the watch picker and the post-session rating panel show, so a blind
 * attribution line can read "Agent N" for the very agent the rater will score. Empty when
 * the env has no play-open season.
 */
export async function watchAgentNumbers(envId: string): Promise<Record<string, number>> {
  const rows = await listWatchAgents(envId)
  return Object.fromEntries(rows.map((row) => [row.submission_id, row.anonymous_number]))
}

/** One submission on the agent profile: its per-stage log plus the recent recordings it ran in. */
export interface AgentProfileSubmission extends SubmissionDetail {
  replays: string[]
}

/** One owner's agent for an environment: submission history (with logs) and recent replays. */
export interface AgentProfile {
  env_id: string
  owner_id: string
  /** The owner's display name, when the directory has one; absent falls back to `owner_id`. */
  owner_name?: string
  /** The owner's linked GitHub handle, present only on this public profile payload. */
  owner_github?: string
  submission_season_id: string | null
  play_season_id: string | null
  submissions: AgentProfileSubmission[]
  /** The owner's rating prompt per season they submitted into, keyed by season id (non-blank only). */
  author_prompts: Record<string, string>
}

/** The active submission attempt summarized on the signed-in user's cross-environment agent index. */
export interface MyAgentSubmissionSummary {
  id: string
  status: SubmissionStatus
  submitted_at: string
}

/** One current or historical season on the signed-in user's cross-environment agent index. */
export interface MyAgentSeasonSummary {
  id: string
  label: string | null
  created_at: string
  release_status: ReleaseStatus
  submission: MyAgentSubmissionSummary | null
  mean_score: number | null
}

/** One environment on My Agents, with its open submission season and recent entered seasons. */
export interface MyAgentEnvironmentSummary {
  env_id: string
  current_season: MyAgentSeasonSummary | null
  previous_seasons: MyAgentSeasonSummary[]
}

/** The signed-in user's season-level submission summary across environments. */
export async function getMyAgents(): Promise<MyAgentEnvironmentSummary[]> {
  return (await json(await request('/my/agents'), 'GET /my/agents')) as MyAgentEnvironmentSummary[]
}

/** An owner's agent profile for an environment: history across seasons, newest first. */
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
  /** Viewer-appropriate name, anonymous while a non-operator rates a playable season. */
  display_name: string
  /** True when the caller owns this submitted agent: the UI shows it without a rating control. */
  is_own: boolean
  /** The agent author's prompt for this season, when set (null for the ownerless Naive baseline). */
  author_prompt: string | null
  /** The caller's current effective rating, or null when they have not rated this agent. */
  your_rating: number | null
}

/** The rating read/write payload for one session: the season prompt and the per-agent view. */
export interface SessionRatings {
  session_id: string
  season_id: string
  /** True when the season's play window is closed: prior ratings show, but no new write is taken. */
  read_only: boolean
  /** The operator's season-wide rating prompt, applying to every agent (null when unset). */
  season_prompt: string | null
  agents: RateableAgent[]
}

/**
 * Reading a finished session's ratings: the view, or a reason it is not rateable. An old session with
 * no season and one without a finalized recording both come back unrateable, so the post-session UI
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

/** The author's per-season rating prompt, as the get/set routes return it (null when unset). */
export interface AuthorPrompt {
  season_id: string
  prompt: string | null
}

/** Read the caller's own rating prompt for a season, to populate the agent-profile editor. */
export async function getAuthorPrompt(seasonId: string): Promise<AuthorPrompt> {
  return (await json(
    await request(`/seasons/${encodeURIComponent(seasonId)}/agent-rating-prompt`),
    'GET /seasons/:seasonId/agent-rating-prompt',
  )) as AuthorPrompt
}

/** Setting (or clearing) the author prompt: the saved value, or a typed refusal. */
export type SetAuthorPromptResult =
  | { ok: true; prompt: string | null }
  | { ok: false; reason: 'no_agent_in_season' | 'too_long' | 'failed' }

/** Set or clear the caller's rating prompt for a season. A null or empty prompt clears it. */
export async function setAuthorPrompt(
  seasonId: string,
  prompt: string | null,
): Promise<SetAuthorPromptResult> {
  const res = await request(`/seasons/${encodeURIComponent(seasonId)}/agent-rating-prompt`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })
  if (res.ok) {
    const body = (await res.json()) as AuthorPrompt
    return { ok: true, prompt: body.prompt }
  }
  const body = (await res.json().catch(() => ({}))) as { code?: string }
  if (body.code === 'no_agent_in_season') {
    return { ok: false, reason: 'no_agent_in_season' }
  }
  if (body.code === 'author_prompt_too_long') {
    return { ok: false, reason: 'too_long' }
  }
  return { ok: false, reason: 'failed' }
}

// --- Seasons, boards, and the admin console (Stage 6.7) -----------------------------------

/**
 * An agent identity as the boards, placements, and scheduled seats carry it. Unlike {@link AgentRefWire}
 * (the rating write shape, which omits `user_id` for the backend to resolve), a board row carries the
 * `user_id` so the UI can link a submitted-agent row to its profile. The Naive baseline has no owner.
 * The shape is shared with the backend enrichment through the schema package, so both wire ends agree.
 */
export type { BoardAgentRef }

/** A public gate's two-valued state, mirrored from the backend's `WindowStatus`. */
export type WindowStatus = 'open' | 'closed'
/** Whether a season's results are shown outside the operator console. */
export type ReleaseStatus = 'unreleased' | 'released'
/** One automated run's lifecycle state. */
export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
/** One scheduled match's lifecycle state. */
export type GameStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled'

/** One seat in a match composition: the built-in scripted baseline, or a participant submission. */
export type SeatSpec = 'builtin-naive' | 'submission'

/** One match configuration: its seat composition, the seeds every game runs, and the game count. */
export interface MatchConfig {
  seats: SeatSpec[]
  seeds: number[]
  games: number
}

/** The season's messaging override (Stage 8). `enabled` can only disable; `message_cap` can only tighten. */
export interface MessagingOverride {
  enabled?: boolean
  message_cap?: number
}

/** Stable model aliases an environment-facing agent or development client may request. */
export type LlmModelAlias = ModelAlias

/** Shared public usage totals, retained here as a compatibility export for API consumers. */
export type LlmModelUsage = SchemaLlmModelUsage

/** Shared public per-model usage, retained here as a compatibility export for API consumers. */
export type LlmUsageByModel = SchemaLlmUsageByModel

/** Optional deployment-default overrides for one official or development accounting scope. */
export interface LlmLimitOverride {
  token_budget?: number
  rate_limit_rpm?: number
}

/** A season's strict LLM enablement, model allowlist, and independently resolved limit groups. */
export interface LlmOverride {
  enabled?: boolean
  models?: LlmModelAlias[]
  cost_weights?: Partial<Record<LlmModelAlias, number>>
  official?: LlmLimitOverride
  development?: LlmLimitOverride
}

/**
 * The override block. Each nested capability has a strict shape shared with the backend season codec.
 */
export interface SeasonOverrides {
  step_timeout_ms?: number
  episode_timeout_ms?: number
  /** Per-season cap (MB) on a submission's checked-out source; absent uses the site default. */
  submission_max_size_mb?: number
  messaging?: MessagingOverride
  llm?: LlmOverride
  parameters?: Record<string, ParameterValue>
}

/** The whole season configuration document (the `seasons.config` JSON, decoded). */
export interface SeasonConfig {
  deps_version: number
  matches: MatchConfig[]
  overrides?: SeasonOverrides
}

/** A season row with decoded config, returned by admin and released-board/history reads. */
export interface SeasonView {
  id: string
  env_id: string
  submission_status: WindowStatus
  play_status: WindowStatus
  release_status: ReleaseStatus
  label: string | null
  config: SeasonConfig
  rating_prompt: string | null
  /** A short, one-paragraph inline Markdown summary shown on public season cards. */
  description_markdown: string | null
  created_at: string
  released_at: string | null
}

/** Public season-index metadata, excluding operator configuration and rating prompts. */
export type PublicSeasonView = Pick<
  SeasonView,
  | 'id'
  | 'env_id'
  | 'submission_status'
  | 'play_status'
  | 'release_status'
  | 'label'
  | 'description_markdown'
  | 'created_at'
  | 'released_at'
> & {
  /** Active participant submissions, excluding superseded attempts. */
  submission_count: number
  /** Games in the season's latest completed automated run — what the released Scoreboard aggregates. */
  game_count: number
}

/** One automated-board row: a per-agent aggregate over the latest completed run's results. */
export interface AutomatedBoardRow {
  agent: BoardAgentRef
  mean_score: number
  /** Population standard deviation of the per-game score, shown as the spread beside the mean. */
  score_std: number
  /** Weighted mean per-decision agent compute time; null when no tick contributed. */
  mean_agent_compute_ms: number | null
  /** Acted-tick-weighted spread of per-game compute rates; null exactly when the mean is. */
  compute_std: number | null
  /** Successful official calls grouped by model, or null when the agent made none. */
  llm_usage_by_model: LlmUsageByModel | null
  /** Successful official token use priced with the run's frozen model weights. */
  llm_weighted_cost: number | null
  failure_count: number
  games: number
  /** The representative replay link (the agent's best game), or null. */
  recording_id: string | null
}

/** One human-feedback-board row: mean rating and count, with the ranking applied (null when unranked). */
export interface HumanBoardRow {
  agent: BoardAgentRef
  mean: number
  /** Population standard deviation of the agent's ratings, shown as the spread beside the mean. */
  std: number
  count: number
  rank: number | null
  /** The agent's representative replay link (its best automated game), or null. */
  recording_id: string | null
  /** The agent author's rating prompt for this season, when set (null for the ownerless Naive baseline). */
  author_prompt: string | null
}

/**
 * Both boards for a season plus its matchup table: the automated aggregate, the human-rating
 * aggregate, and the per-game list of the latest completed run. `games` lets a reader reach every game
 * of a multi-seat matchup, where the board only links one representative replay per agent.
 */
export interface Board {
  automated: AutomatedBoardRow[]
  human: HumanBoardRow[]
  games: RunGameView[]
}

/** One scheduled game with its resolved seats decoded; the run panel shows per-game status. */
export interface RunGameView {
  id: string
  run_id: string
  match_index: number
  game_index: number
  seed: number
  seats: BoardAgentRef[]
  status: GameStatus
  recording_id: string | null
  started_at: string | null
  ended_at: string | null
  error: string | null
}

/** A run with its frozen snapshots decoded and its scheduled games attached (the admin status view). */
export interface RunView {
  id: string
  season_id: string
  requested_by: string
  /** The requester's display name, when the directory has one; absent falls back to `requested_by`. */
  requested_by_name?: string
  config_snapshot: SeasonConfig
  submission_snapshot: BoardAgentRef[]
  status: RunStatus
  started_at: string
  ended_at: string | null
  error: string | null
  games: RunGameView[]
}

/** A run as the runs-list reads it: identity, status, timestamps, error, and a game count (no snapshots). */
export interface RunSummaryView {
  id: string
  season_id: string
  requested_by: string
  /** The requester's display name, when the directory has one; absent falls back to `requested_by`. */
  requested_by_name?: string
  status: RunStatus
  started_at: string
  ended_at: string | null
  error: string | null
  game_count: number
}

/** The full admin view of one season: its config and gates, the latest run, and both boards. */
export interface AdminSeasonView {
  season: SeasonView
  latest_run: RunView | null
  board: Board
}

/** The current released season plus its boards, as the environment leaderboards read returns it. */
export interface CurrentLeaderboards {
  season: SeasonView
  board: Board
}

/**
 * The environment leaderboards payload: the current released boards (or null when nothing is released),
 * plus the separate public submit and play targets, reported even when their seasons are unreleased.
 */
export interface EnvironmentLeaderboards {
  current: CurrentLeaderboards | null
  submission_season_id: string | null
  play_season_id: string | null
}

/** One automated placement on an agent profile, read from the public placements route. */
export interface AutomatedPlacement {
  id: string
  season_id: string
  env_id: string
  run_id: string
  rank: number
  agent_kind: 'submission' | 'builtin-naive'
  agent_submission_id: string | null
  agent_user_id: string | null
  mean_score: number
  mean_agent_compute_ms: number | null
  /** Successful official calls grouped by model, or null when the placement has none. */
  llm_usage_by_model: LlmUsageByModel | null
  /** Successful official token use priced with the run's frozen model weights. */
  llm_weighted_cost: number | null
  failure_count: number
  recording_id: string | null
  created_at: string
}

/**
 * One placement as the profile page reads it: the stored automated row plus the two derived,
 * read-time fields the profile shows alongside it — the season's display label and the agent's
 * live human-rating aggregate (mean and count) for that season.
 */
export interface AgentPlacementView extends AutomatedPlacement {
  season_label: string | null
  /** Mean human rating for this agent that season, or null when it has no ratings yet. */
  human_mean: number | null
  human_count: number
}

/** An agent's released placements for an environment, newest first, for the profile page. */
export interface AgentPlacements {
  env_id: string
  owner_id: string
  placements: AgentPlacementView[]
}

// --- Public, released-only reads -------------------------------------------------------------

/** The current released season's boards plus the separate public submit and play targets. */
export async function getEnvironmentLeaderboards(envId: string): Promise<EnvironmentLeaderboards> {
  return (await json(
    await request(`/environments/${encodeURIComponent(envId)}/leaderboards`),
    'GET /environments/:envId/leaderboards',
  )) as EnvironmentLeaderboards
}

/** The environment's released seasons, newest first, for the history links. */
export async function listReleasedSeasons(envId: string): Promise<SeasonView[]> {
  return (await json(
    await request(`/environments/${encodeURIComponent(envId)}/seasons`),
    'GET /environments/:envId/seasons',
  )) as SeasonView[]
}

/**
 * Every public-facing season — released, submission-open, or play-open — newest first, optionally
 * narrowed to a single environment. Backs the cross-game seasons list and the per-environment hub;
 * identity, labels, flags, timestamps, and aggregate activity counts only, never config, rating
 * prompts, or boards. Operators may pass `includeUnreleased` to also receive unreleased and
 * fully-private seasons (the leaderboards page and admin console use this); the backend refuses the
 * flag for non-operators.
 */
export async function listSeasons(
  envId?: string,
  options?: { includeUnreleased?: boolean },
): Promise<PublicSeasonView[]> {
  const params = new URLSearchParams()
  if (envId !== undefined) params.set('envId', envId)
  if (options?.includeUnreleased === true) params.set('includeUnreleased', 'true')
  const query = params.toString()
  return (await json(
    await request(query === '' ? '/seasons' : `/seasons?${query}`),
    'GET /seasons',
  )) as PublicSeasonView[]
}

/**
 * Both boards for a specific released season. Returns `undefined` for an unreleased or unknown
 * season, which the public route answers with 404 — the boundary that keeps unreleased boards private.
 */
export async function getSeasonLeaderboards(
  envId: string,
  seasonId: string,
): Promise<CurrentLeaderboards | undefined> {
  const res = await request(
    `/environments/${encodeURIComponent(envId)}/seasons/${encodeURIComponent(seasonId)}/leaderboards`,
  )
  if (res.status === 404) {
    return undefined
  }
  return (await json(
    res,
    'GET /environments/:envId/seasons/:seasonId/leaderboards',
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

/** The full admin view of one season: config, gates, latest run, and both (possibly unreleased) boards. */
export async function getAdminSeason(seasonId: string): Promise<AdminSeasonView> {
  return (await json(
    await request(`/admin/seasons/${encodeURIComponent(seasonId)}`),
    'GET /api/admin/seasons/:id',
  )) as AdminSeasonView
}

/** Every run for a season, newest first, as lightweight summaries for the console's runs list. */
export async function listRuns(seasonId: string): Promise<RunSummaryView[]> {
  return (await json(
    await request(`/admin/seasons/${encodeURIComponent(seasonId)}/runs`),
    'GET /api/admin/seasons/:id/runs',
  )) as RunSummaryView[]
}

/** One active submission in a season, as the admin submissions list returns it (with snapshot state). */
export interface AdminSubmissionRow {
  id: string
  user_id: string
  /** The submitter's display name, when the directory has one; absent falls back to `user_id`. */
  user_name?: string
  status: SubmissionStatus
  source_kind: 'git' | 'local'
  repo_url: string | null
  commit_sha: string | null
  ref: string | null
  created_at: string
  /** Whether a downloadable source snapshot exists (false for a submission that failed before snapshot). */
  has_snapshot: boolean
}

/** A season's active submissions (one current attempt per participant), for the operator console. */
export async function listSeasonSubmissions(seasonId: string): Promise<AdminSubmissionRow[]> {
  return (await json(
    await request(`/admin/seasons/${encodeURIComponent(seasonId)}/submissions`),
    'GET /api/admin/seasons/:id/submissions',
  )) as AdminSubmissionRow[]
}

/**
 * The operator download URL for one submission's source snapshot. A native `<a download>` navigation
 * sends the Better Auth session cookie on this same-origin request, so the admin guard authenticates
 * it with no `?user=` channel. Returns a string for an anchor href, not a fetch wrapper.
 */
export function adminSubmissionDownloadUrl(submissionId: string): string {
  return `${API_BASE}/admin/submissions/${encodeURIComponent(submissionId)}/download`
}

/** The operator download URL for a whole season's active submissions, as one `.tar.gz`. */
export function adminSeasonDownloadUrl(seasonId: string): string {
  return `${API_BASE}/admin/seasons/${encodeURIComponent(seasonId)}/submissions/download`
}

/** One run's full view with its scheduled games, the run-details page's primary read. */
export async function getRun(seasonId: string, runId: string): Promise<RunView> {
  return (await json(
    await request(
      `/admin/seasons/${encodeURIComponent(seasonId)}/runs/${encodeURIComponent(runId)}`,
    ),
    'GET /api/admin/seasons/:id/runs/:runId',
  )) as RunView
}

/** Declare a new unreleased, submission-closed, play-closed season for the environment. */
export async function declareSeason(
  envId: string,
  input: { label?: string | null; depsVersion?: number } = {},
): Promise<SeasonView> {
  const body: Record<string, unknown> = {}
  if (input.label !== undefined) body.label = input.label
  if (input.depsVersion !== undefined) body.deps_version = input.depsVersion
  const res = await request(`/admin/environments/${encodeURIComponent(envId)}/seasons`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await json(res, 'POST /api/admin/environments/:envId/seasons')) as SeasonView
}

/** The outcome of permanently deleting an inactive, unreleased season. */
export type DeleteSeasonResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'season_not_deletable' | 'season_not_empty' | 'failed' }

/** Permanently delete a closed, unreleased season that has no submissions, runs, or recordings. */
export async function deleteSeason(seasonId: string): Promise<DeleteSeasonResult> {
  const res = await request(`/admin/seasons/${encodeURIComponent(seasonId)}`, { method: 'DELETE' })
  if (res.status === 204) {
    return { ok: true }
  }
  if (res.status === 404) {
    return { ok: false, reason: 'not_found' }
  }
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { code?: string }
    if (body.code === 'season_not_deletable' || body.code === 'season_not_empty') {
      return { ok: false, reason: body.code }
    }
  }
  return { ok: false, reason: 'failed' }
}

/**
 * The outcome of replacing a season's config. An unforced edit against existing runs (or a
 * `deps_version` change against existing submissions) is refused; the console re-sends with `force`
 * after the confirmation dialog. An invalid config carries the backend's specific reason.
 */
export type ConfigureSeasonResult =
  | { ok: true; season: SeasonView }
  | {
      ok: false
      reason: 'season_has_runs' | 'season_has_submissions' | 'invalid_config' | 'failed'
      message: string
    }

/** Replace a season's whole config. `force` carries the destructive-edit confirmation. */
export async function configureSeason(
  seasonId: string,
  config: SeasonConfig,
  force = false,
): Promise<ConfigureSeasonResult> {
  const query = force ? '?force=true' : ''
  const res = await request(`/admin/seasons/${encodeURIComponent(seasonId)}/config${query}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  })
  if (res.ok) {
    return { ok: true, season: (await res.json()) as SeasonView }
  }
  const body = (await res.json().catch(() => ({}))) as {
    code?: string
    reason?: string
    error?: string
  }
  const reason =
    body.code === 'season_has_runs' ||
    body.code === 'season_has_submissions' ||
    body.code === 'invalid_config'
      ? body.code
      : 'failed'
  return { ok: false, reason, message: body.reason ?? body.error ?? res.statusText }
}

/** The outcome of setting the operator's season-wide rating prompt; an overlong prompt is typed. */
export type SetSeasonRatingPromptResult =
  | { ok: true; season: SeasonView }
  | { ok: false; reason: 'too_long' | 'failed' }

/** The outcome of setting the short public season description. */
export type SetSeasonDescriptionResult =
  | { ok: true; season: SeasonView }
  | { ok: false; reason: 'too_long' | 'multiple_paragraphs' | 'invalid' | 'failed' }

/** Set or clear the operator-editable public season description. */
export async function setSeasonDescription(
  seasonId: string,
  markdown: string | null,
): Promise<SetSeasonDescriptionResult> {
  const res = await request(`/admin/seasons/${encodeURIComponent(seasonId)}/description`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ markdown }),
  })
  if (res.ok) return { ok: true, season: (await res.json()) as SeasonView }
  const body = (await res.json().catch(() => ({}))) as { code?: string }
  const reason =
    body.code === 'season_description_too_long'
      ? 'too_long'
      : body.code === 'season_description_multiple_paragraphs'
        ? 'multiple_paragraphs'
        : body.code === 'invalid_season_description'
          ? 'invalid'
          : 'failed'
  return { ok: false, reason }
}
/** Set or clear the operator's always-editable season rating prompt. */
export async function setSeasonRatingPrompt(
  seasonId: string,
  prompt: string | null,
): Promise<SetSeasonRatingPromptResult> {
  const res = await request(`/admin/seasons/${encodeURIComponent(seasonId)}/rating-prompt`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })
  if (res.ok) {
    return { ok: true, season: (await res.json()) as SeasonView }
  }
  const body = (await res.json().catch(() => ({}))) as { code?: string }
  if (body.code === 'rating_prompt_too_long') {
    return { ok: false, reason: 'too_long' }
  }
  return { ok: false, reason: 'failed' }
}

/** The outcome of renaming a season; an overlong label comes back typed. */
export type RenameSeasonResult =
  | { ok: true; season: SeasonView }
  | { ok: false; reason: 'too_long' | 'failed' }

/** Rename a season (or clear its label by passing null/empty). Editable at any point in its life. */
export async function renameSeason(
  seasonId: string,
  label: string | null,
): Promise<RenameSeasonResult> {
  const res = await request(`/admin/seasons/${encodeURIComponent(seasonId)}/label`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  })
  if (res.ok) {
    return { ok: true, season: (await res.json()) as SeasonView }
  }
  const body = (await res.json().catch(() => ({}))) as { code?: string }
  if (body.code === 'season_label_too_long') {
    return { ok: false, reason: 'too_long' }
  }
  return { ok: false, reason: 'failed' }
}

/** The outcome of opening the submission window: a typed conflict when another season is open. */
export type OpenSubmissionsResult =
  | { ok: true; season: SeasonView }
  | { ok: false; reason: 'open_season_exists' | 'failed' }

/** Open the submission window. The one-open-submission invariant surfaces as `open_season_exists`. */
export async function openSubmissions(seasonId: string): Promise<OpenSubmissionsResult> {
  const res = await request(`/admin/seasons/${encodeURIComponent(seasonId)}/submissions/open`, {
    method: 'POST',
  })
  if (res.ok) {
    return { ok: true, season: (await res.json()) as SeasonView }
  }
  const body = (await res.json().catch(() => ({}))) as { code?: string }
  return {
    ok: false,
    reason: body.code === 'open_season_exists' ? 'open_season_exists' : 'failed',
  }
}

/** Close the submission window. */
export async function closeSubmissions(seasonId: string): Promise<SeasonView> {
  return (await json(
    await request(`/admin/seasons/${encodeURIComponent(seasonId)}/submissions/close`, {
      method: 'POST',
    }),
    'POST /api/admin/seasons/:id/submissions/close',
  )) as SeasonView
}

/** The outcome of opening public play: a typed conflict when another season is already play-open. */
export type OpenPlayResult =
  | { ok: true; season: SeasonView }
  | { ok: false; reason: 'open_play_season_exists' | 'failed' }

/** Open the public-play window. The one-play-open invariant surfaces as `open_play_season_exists`. */
export async function openPlay(seasonId: string): Promise<OpenPlayResult> {
  const res = await request(`/admin/seasons/${encodeURIComponent(seasonId)}/play/open`, {
    method: 'POST',
  })
  if (res.ok) {
    return { ok: true, season: (await res.json()) as SeasonView }
  }
  const body = (await res.json().catch(() => ({}))) as { code?: string }
  return {
    ok: false,
    reason: body.code === 'open_play_season_exists' ? 'open_play_season_exists' : 'failed',
  }
}

/** Close the public-play window. */
export async function closePlay(seasonId: string): Promise<SeasonView> {
  return (await json(
    await request(`/admin/seasons/${encodeURIComponent(seasonId)}/play/close`, {
      method: 'POST',
    }),
    'POST /api/admin/seasons/:id/play/close',
  )) as SeasonView
}

/** Release the season's results, exposing its boards on the environment page. */
export async function releaseSeason(seasonId: string): Promise<SeasonView> {
  return (await json(
    await request(`/admin/seasons/${encodeURIComponent(seasonId)}/release`, {
      method: 'POST',
    }),
    'POST /api/admin/seasons/:id/release',
  )) as SeasonView
}

/** Pull the season's results back to operator-only. */
export async function unreleaseSeason(seasonId: string): Promise<SeasonView> {
  return (await json(
    await request(`/admin/seasons/${encodeURIComponent(seasonId)}/unrelease`, {
      method: 'POST',
    }),
    'POST /api/admin/seasons/:id/unrelease',
  )) as SeasonView
}

/** The outcome of triggering a run: the new run id, or a typed refusal the console surfaces. */
export type TriggerRunResult =
  | { ok: true; id: string; status: RunStatus }
  | { ok: false; reason: 'run_in_progress' | 'empty_schedule' | 'failed'; message: string }

/** Trigger (or re-run) the workflow. Non-blocking; returns the new run id immediately. */
export async function triggerRun(seasonId: string): Promise<TriggerRunResult> {
  const res = await request(`/admin/seasons/${encodeURIComponent(seasonId)}/runs`, {
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
export async function cancelRun(seasonId: string, runId: string): Promise<CancelRunResult> {
  const res = await request(
    `/admin/seasons/${encodeURIComponent(seasonId)}/runs/${encodeURIComponent(runId)}/cancel`,
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
export function runLogWsPath(seasonId: string, runId: string): string {
  return `/api/admin/seasons/${encodeURIComponent(seasonId)}/runs/${encodeURIComponent(runId)}/logs/ws`
}

// --- LLM development access ----------------------------------------------------------------

export interface LlmDevelopmentLimits {
  token_budget: number
  rate_limit_rpm: number
}

export interface LlmDevelopmentModelUsage {
  calls: number
  input_tokens: number
  reasoning_tokens: number
  output_tokens: number
}

export interface LlmDevelopmentSummary {
  season_id: string
  models: LlmModelAlias[]
  cost_weights: Partial<Record<LlmModelAlias, number>>
  limits: LlmDevelopmentLimits
  usage_by_model: Record<string, LlmDevelopmentModelUsage>
  successful_calls: number
  usage_estimated: boolean
  budget_cost_units_used: number
  budget_cost_units_remaining: number
  key_exists: boolean
}

export interface LlmDevelopmentSeason extends Omit<LlmDevelopmentSummary, 'usage_by_model'> {
  label: string | null
  environment: string
}

export interface LlmDevelopmentCall {
  id: number
  created_at: string
  model: string
  input_tokens: number
  reasoning_tokens: number
  output_tokens: number
  usage_estimated: boolean
  cost_weight: number
  budget_cost_units: number
  request: unknown
  completion: unknown
}

export interface LlmDevelopmentCallPage {
  calls: LlmDevelopmentCall[]
  next_cursor: number | null
}

/** Plaintext is returned once after first creation or rotation. */
export interface LlmDevelopmentCredential {
  season_id: string
  base_url: string
  api_key: string
  models: LlmModelAlias[]
  cost_weights: Partial<Record<LlmModelAlias, number>>
  limits: LlmDevelopmentLimits
}

export interface AdminLlmDevelopmentUser {
  user_id: string
  successful_calls: number
  usage_estimated: boolean
  budget_cost_units_used: number
  budget_cost_units_remaining: number
}

export interface LlmCallPageOptions {
  cursor?: number
  limit?: number
}

function llmCallPageQuery(options: LlmCallPageOptions): string {
  const params = new URLSearchParams()
  if (options.cursor !== undefined) params.set('cursor', String(options.cursor))
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  const query = params.toString()
  return query.length === 0 ? '' : `?${query}`
}

export async function listLlmDevelopmentSeasons(): Promise<LlmDevelopmentSeason[]> {
  return (await json(
    await request('/llm-development/seasons'),
    'GET /llm-development/seasons',
  )) as LlmDevelopmentSeason[]
}

export async function getLlmDevelopmentSummary(seasonId: string): Promise<LlmDevelopmentSummary> {
  return (await json(
    await request(`/seasons/${encodeURIComponent(seasonId)}/llm-development`),
    'GET /seasons/:seasonId/llm-development',
  )) as LlmDevelopmentSummary
}

export async function listLlmDevelopmentCalls(
  seasonId: string,
  options: LlmCallPageOptions = {},
): Promise<LlmDevelopmentCallPage> {
  return (await json(
    await request(
      `/seasons/${encodeURIComponent(seasonId)}/llm-development/calls${llmCallPageQuery(options)}`,
    ),
    'GET /seasons/:seasonId/llm-development/calls',
  )) as LlmDevelopmentCallPage
}

export async function rotateLlmDevelopmentKey(seasonId: string): Promise<LlmDevelopmentCredential> {
  return (await json(
    await request(`/seasons/${encodeURIComponent(seasonId)}/llm-development-key`, {
      method: 'POST',
    }),
    'POST /seasons/:seasonId/llm-development-key',
  )) as LlmDevelopmentCredential
}

export async function listAdminLlmDevelopmentUsers(
  seasonId: string,
): Promise<AdminLlmDevelopmentUser[]> {
  return (await json(
    await request(`/admin/seasons/${encodeURIComponent(seasonId)}/llm-development`),
    'GET /admin/seasons/:seasonId/llm-development',
  )) as AdminLlmDevelopmentUser[]
}

export async function listAdminLlmDevelopmentCalls(
  seasonId: string,
  userId: string,
  options: LlmCallPageOptions = {},
): Promise<LlmDevelopmentCallPage> {
  return (await json(
    await request(
      `/admin/seasons/${encodeURIComponent(seasonId)}/llm-development/users/${encodeURIComponent(userId)}/calls${llmCallPageQuery(options)}`,
    ),
    'GET /admin/seasons/:seasonId/llm-development/users/:userId/calls',
  )) as LlmDevelopmentCallPage
}
