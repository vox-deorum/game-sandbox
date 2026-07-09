/**
 * Server-side blind masking for recording attribution (Stage 12.4 hardening).
 *
 * Blind rating hides a submitted agent's owner (and a human seat's identity) from non-operators while
 * a season is still playable, so feedback is unbiased. That masking cannot live only in the browser:
 * a recording header carries the owner's display name and stable id baked in at launch, and the
 * recordings API (`GET /api/recordings` and the raw `GET /api/recordings/:id` stream) is public, so a
 * caller bypassing the UI would otherwise read exactly what blind mode is meant to hide. This module is
 * the one authoritative place the blind decision and the header masking are made, mirroring the
 * frontend's `attribution.ts` policy so a masked response and the client's own re-masking compose to
 * the same result.
 *
 * The masking keeps each seat's `submission_id` (an opaque token with no public owner mapping while the
 * season is open, and the same value the frontend already carries to number "Submitted agent N") but
 * strips the reversible `user` id and replaces the display `label`. The viewer's own seat is never
 * masked, so a participant can still find themselves.
 */

import { Transform } from 'node:stream'
import type { RecordingHeader } from '@game-sandbox/schema'

import type { AuthUser } from './identity.js'

type Players = NonNullable<RecordingHeader['players']>

/** Whether a header names at least one submitted agent — the only thing blind masking has to protect. */
export function headerHasSubmittedAgent(players: Players | undefined): boolean {
  if (players === undefined) {
    return false
  }
  return Object.values(players).some(
    (player) => player.kind === 'agent' && player.submission_id !== undefined,
  )
}

/**
 * The blind decision for one recording and one caller, matching the frontend's `isBlindReplay` gate:
 * an operator is never blind, a recording with no play-open season is never blind, and a recording with
 * no submitted agent has nothing to hide. Fail closed: an unresolved (anonymous) caller stays blind.
 */
export function isBlindRecording(
  caller: AuthUser | null,
  seasonPlayStatus: string | undefined,
  players: Players | undefined,
): boolean {
  if (caller?.status === 'admin') {
    return false
  }
  if (seasonPlayStatus !== 'open') {
    return false
  }
  return headerHasSubmittedAgent(players)
}

/**
 * Mask a header's `players` for a blind viewer: a non-own human seat becomes the neutral "Human", a
 * non-own submitted agent keeps its opaque `submission_id` but loses the owner `user` id and its
 * "<owner>'s agent" label, and the built-in Naive agent (no owner) is left as-is. The viewer's own seat
 * (matched by the stable `user` id) is returned untouched so they can still recognize it.
 */
export function maskPlayers(players: Players, callerId: string | undefined): Players {
  const masked: Players = {}
  for (const [slot, player] of Object.entries(players)) {
    if (player.user !== undefined && player.user === callerId) {
      masked[slot] = player
    } else if (player.kind === 'human') {
      masked[slot] = { kind: 'human', label: 'Human' }
    } else if (player.submission_id !== undefined) {
      masked[slot] = {
        kind: 'agent',
        label: 'Submitted agent',
        submission_id: player.submission_id,
      }
    } else {
      masked[slot] = player
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
