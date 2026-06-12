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
