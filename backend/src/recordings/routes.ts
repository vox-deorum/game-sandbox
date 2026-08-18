/** HTTP routes for listing, streaming, pinning, and unpinning recordings. */
import type { RecordingHeader } from '@game-sandbox/schema'
import type { FastifyInstance, FastifyReply } from 'fastify'

import type { RequestIdentity } from '../auth/identity.js'
import type { UserDirectory } from '../auth/users.js'
import type { Storage } from '../storage/index.js'
import { optionalField } from '../util/optional-field.js'
import type { PinResult, Retention } from './retention.js'
import { isSafeRecordingId, type RecordingsStore } from './store.js'
import { isBlindRecording, maskPlayers, replaceHeaderLine } from './view.js'

export interface RecordingRouteDeps {
  recordings: RecordingsStore
  retention: Retention
  identity: RequestIdentity
  storage: Pick<Storage, 'getSeason' | 'listSessions'>
  userDirectory: UserDirectory
}

/** Register the recordings HTTP routes. */
export function registerRecordingRoutes(app: FastifyInstance, deps: RecordingRouteDeps): void {
  const { identity } = deps

  // The merged listing: each readable recording's header plus its retention metadata (owner, age,
  // pin state), optionally narrowed to one environment with `?env=`. Open to everyone (read-only).
  // Owner display names are attached here at the route boundary, one batched lookup over the whole
  // listing, so retention itself stays directory-free. Blind rating is enforced here too: a non-owner
  // (non-operator) viewing a still-playable recording gets its header attribution masked and its owner
  // fields stripped, so the public API never leaks what the UI hides. See view.ts.
  app.get<{ Querystring: { env?: string } }>('/api/recordings', async (request) => {
    const listings = await deps.retention.list({ env: request.query.env })
    const caller = await identity.resolveUser(request)
    const names = await deps.userDirectory.namesFor(
      listings.flatMap((listing) => (listing.user_id === null ? [] : [listing.user_id])),
    )
    // The play status of every season the listing references, so each recording's blind state is a
    // map lookup rather than a per-row query.
    const seasonIds = [
      ...new Set(
        listings.flatMap((listing) => (listing.season_id === null ? [] : [listing.season_id])),
      ),
    ]
    const playStatuses = new Map(
      await Promise.all(
        seasonIds.map(async (id) => [id, (await deps.storage.getSeason(id))?.play_status] as const),
      ),
    )
    return listings.map((listing) => {
      const header = { ...(listing.header as RecordingHeader) }
      delete header.overlay_static
      const playStatus =
        listing.season_id === null ? undefined : playStatuses.get(listing.season_id)
      if (isBlindRecording(caller, playStatus, header.players)) {
        // Mask the seat attribution, drop the owner name, and keep the owner id only for the owner
        // (who needs it to recognize and pin their own recording).
        const maskedHeader =
          header.players === undefined
            ? header
            : { ...header, players: maskPlayers(header.players, caller?.id) }
        return {
          ...listing,
          header: maskedHeader,
          user_id: caller?.id === listing.user_id ? listing.user_id : null,
        }
      }
      const name = listing.user_id === null ? undefined : names.get(listing.user_id)
      return { ...listing, header, ...optionalField('user_name', name) }
    })
  })

  app.get<{ Params: { id: string } }>('/api/recordings/:id', async (request, reply) => {
    if (!isSafeRecordingId(request.params.id)) {
      return reply.code(400).send({ error: 'invalid recording id', code: 'invalid_request' })
    }
    if (!(await deps.recordings.exists(request.params.id))) {
      return reply.code(404).send({ error: 'no such recording' })
    }
    // The raw stream is masked the same way the listing is: resolve the caller, find the producing
    // session's season, and if this is a blind view rewrite only the header line before streaming the
    // (unchanged) state lines. A non-blind view streams the file untouched, the fast common path.
    const caller = await identity.resolveUser(request)
    const header = await deps.recordings.readHeader(request.params.id)
    const players = header?.players
    const session = (await deps.storage.listSessions()).find(
      (row) => row.recording_id === request.params.id,
    )
    const playStatus =
      session?.season_id == null
        ? undefined
        : (await deps.storage.getSeason(session.season_id))?.play_status
    reply.type('application/x-ndjson')
    if (
      header === undefined ||
      players === undefined ||
      !isBlindRecording(caller, playStatus, players)
    ) {
      return reply.send(deps.recordings.stream(request.params.id))
    }
    const maskedHeaderLine = JSON.stringify({
      ...header,
      players: maskPlayers(players, caller?.id),
    })
    return reply.send(
      replaceHeaderLine(deps.recordings.stream(request.params.id), maskedHeaderLine),
    )
  })

  // Pin and unpin are owner-only and gate on the recording's retention row. They sit under
  // `requireUser` (not `requireActive`) because they are an owner's own-library actions already scoped
  // by the ownership check below; a pending user is admitted but owns no recordings to pin (they
  // cannot start sessions), so the looser gate is inert today. Pinning is refused with `pinned_quota`
  // once the user is at their pinned cap, so the per-user quota stays a hard bound on storage even
  // though pinned recordings are exempt from eviction.
  app.post<{ Params: { id: string } }>('/api/recordings/:id/pin', async (request, reply) => {
    const user = await identity.requireUser(request, reply)
    if (user === undefined) {
      return
    }
    return replyPin(reply, deps.retention.pin(request.params.id, user.id))
  })
  app.delete<{ Params: { id: string } }>('/api/recordings/:id/pin', async (request, reply) => {
    const user = await identity.requireUser(request, reply)
    if (user === undefined) {
      return
    }
    return replyPin(reply, deps.retention.unpin(request.params.id, user.id))
  })
}

/** Map a {@link PinResult} onto its HTTP status, mirroring the typed codes. */
async function replyPin(reply: FastifyReply, result: Promise<PinResult>): Promise<unknown> {
  const outcome = await result
  if (outcome.ok) {
    return reply.code(204).send()
  }
  switch (outcome.reason) {
    case 'not_found':
      return reply.code(404).send({ error: 'no such recording' })
    case 'forbidden':
      return reply.code(403).send({ error: 'not your recording' })
    case 'pinned_quota':
      return reply.code(409).send({ error: 'pinned recording quota reached', code: 'pinned_quota' })
  }
}
