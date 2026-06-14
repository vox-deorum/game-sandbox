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

/** Who-am-I and what-may-I-do, the frontend's single source for the allowlist gate. */
export interface Me {
  user_id: string
  allowlisted: boolean
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

/** A submission row without its per-stage log: the shape the active-iteration listing returns. */
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
