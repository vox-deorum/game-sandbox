/**
 * Server-side blind masking for recording attribution (Stage 12.4 hardening, extended for masked
 * viewers).
 *
 * Blind rating hides a submitted agent's owner (and a human seat's identity) from non-operators while
 * a season is still playable, so feedback is unbiased. Separately, anonymous and guest viewers never
 * see real user names at all: their public reads are masked wherever names would appear. That masking
 * cannot live only in the browser: a recording header carries the owner's display name and stable id
 * baked in at launch, and the recordings API (`GET /api/recordings` and the raw
 * `GET /api/recordings/:id` stream) is public, so a caller bypassing the UI would otherwise read
 * exactly what the rules are meant to hide. This module is the one authoritative place the blind
 * decision and the header masking are made, mirroring the frontend's `attribution.ts` policy so a
 * masked response and the client's own re-masking compose to the same result.
 *
 * The masking keeps each seat's `submission_id` (an opaque token with no public owner mapping while the
 * season is open, and the same value the frontend already carries to number "Agent N"). For a season
 * open to plain blind rating it strips the reversible `user` id and replaces the display `label` with
 * the neutral "Agent"/"Human"; for a masked (anonymous or guest) viewer it instead writes the stable
 * hash label `Agent <hash>` so the viewer can follow one agent without learning who owns it. The
 * viewer's own seat is never masked, so a participant can still find themselves. The live session
 * WebSocket rewrites its header line per socket with these same helpers, so a live spectator and a
 * replay reader see identical masking.
 */

import { Transform } from 'node:stream'
import type { RecordingHeader } from '@game-sandbox/schema'
import { maskedAgentLabel } from '@game-sandbox/schema/accounts'

import { type AuthUser, namesVisible } from '../auth/identity.js'

type Players = NonNullable<RecordingHeader['players']>

/** Whether a header names at least one submitted agent, the only thing plain blind rating hides. */
export function headerHasSubmittedAgent(players: Players | undefined): boolean {
  if (players === undefined) {
    return false
  }
  return Object.values(players).some(
    (player) => player.kind === 'agent' && 'submission_id' in player,
  )
}

/** Whether a header names a submitted agent or a human player, the identities a masked viewer must
 *  not see a real name for (built-in agents carry no identity). */
function headerHasMaskablePlayer(players: Players | undefined): boolean {
  if (players === undefined) {
    return false
  }
  return Object.values(players).some(
    (player) => player.kind === 'human' || 'submission_id' in player,
  )
}

/**
 * The blind decision for one recording and one caller: an operator is never blind, a recording with
 * no play-open season is never blind for a name-visible caller, and a recording with no submitted
 * agent has nothing to hide for the plain rating case. A masked caller (anonymous, or a guest, who
 * never sees real names) is blind whenever the header carries any identity to hide, regardless of the
 * play window. Fail closed: an unresolved (anonymous) caller stays blind.
 */
export function isBlindRecording(
  caller: AuthUser | null,
  seasonPlayStatus: string | undefined,
  players: Players | undefined,
): boolean {
  if (!namesVisible(caller)) {
    return headerHasMaskablePlayer(players)
  }
  if (caller?.status === 'admin') {
    return false
  }
  if (seasonPlayStatus !== 'open') {
    return false
  }
  return headerHasSubmittedAgent(players)
}

/**
 * Mask a header's `players` for a blind viewer: a non-own human player becomes the neutral "Human" (or
 * the `Agent <hash>` label for a masked viewer, so a human seat is indistinguishable from an agent
 * seat), a non-own submitted agent keeps its opaque `submission_id` but loses the owner `user` id and
 * its "<owner>'s agent" label (becoming neutral "Agent", or `Agent <hash>` for a masked viewer), and a
 * built-in agent (which has no owner) is left as-is. The viewer's own player (matched by the stable
 * `user` id) is returned untouched so they can still recognize it.
 */
export function maskPlayers(
  players: Players,
  callerId: string | undefined,
  maskedViewer = false,
): Players {
  const masked: Players = {}
  for (const [playerId, player] of Object.entries(players)) {
    // The `user !== undefined` check is load-bearing: an anonymous caller has no id, and matching
    // an absent owner against it would hand back the unmasked row. `frontend/src/lib/attribution.ts`
    // makes the same check, and the two must compose to the same result.
    if ('user' in player && player.user !== undefined && player.user === callerId) {
      masked[playerId] = player
    } else if (player.kind === 'human') {
      const user = 'user' in player ? player.user : undefined
      masked[playerId] = {
        kind: 'human',
        label: maskedViewer && user !== undefined ? maskedAgentLabel(user) : 'Human',
      }
    } else if ('submission_id' in player) {
      const user = 'user' in player ? player.user : undefined
      masked[playerId] = {
        kind: 'agent',
        label: maskedViewer && user !== undefined ? maskedAgentLabel(user) : 'Agent',
        submission_id: player.submission_id,
      }
    } else {
      masked[playerId] = player
    }
  }
  return masked
}

/**
 * A pass-through stream that rewrites only a recording's first NDJSON line (its header) to
 * `replacementHeaderLine`, leaving every subsequent state line byte-for-byte unchanged. Used to serve a
 * blind-masked header over the raw recording stream without buffering the whole (possibly large)
 * recording. The body is pushed as raw Buffers so state lines are never re-encoded.
 */
export function replaceHeaderLine(
  source: NodeJS.ReadableStream,
  replacementHeaderLine: string,
): Transform {
  let headerDone = false
  let buffer = ''
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      if (headerDone) {
        this.push(chunk)
        callback()
        return
      }
      buffer += chunk.toString('utf-8')
      const newline = buffer.indexOf('\n')
      if (newline === -1) {
        callback()
        return
      }
      headerDone = true
      this.push(`${replacementHeaderLine}\n${buffer.slice(newline + 1)}`)
      buffer = ''
      callback()
    },
    flush(callback) {
      // A degenerate header-only recording (no trailing newline) still emits the masked header.
      if (!headerDone) {
        this.push(replacementHeaderLine)
      }
      callback()
    },
  })
  source.on('error', (error) => transform.destroy(error))
  return source.pipe(transform)
}
