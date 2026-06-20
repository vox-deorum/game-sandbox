/**
 * The public leaderboard and history reads (Stage 6.3), separate from the operator `/api/admin`
 * prefix and ungated. The separation is the security boundary: every board/history read here serves
 * only `released` seasons at the route boundary, so an unreleased season's results cannot leak
 * through a public endpoint no matter the caller. A submission-open or play-open season is still
 * reported as a public target, since an open window makes a season reachable for submitting or
 * playing without exposing its boards.
 */
import type { FastifyInstance } from 'fastify'

import { publicSeasonView, seasonView } from '../season-views.js'
import type { Storage } from '../storage/index.js'

/** Everything the public leaderboard reads need. */
export interface LeaderboardDeps {
  storage: Storage
}

/** Read both boards for a released season: the automated aggregate and the human-rating aggregate. */
async function boardsFor(storage: Storage, seasonId: string) {
  const [automated, human] = await Promise.all([
    storage.getAutomatedBoard(seasonId),
    storage.getHumanBoard(seasonId),
  ])
  return { automated, human }
}

/** Register the public, released-only leaderboard and history routes. */
export function registerLeaderboardRoutes(app: FastifyInstance, deps: LeaderboardDeps): void {
  // Every public-facing season — released, submission-open, or play-open — newest first, for the
  // cross-game seasons list. Pass `?envId=` to narrow to a single environment (the hub uses this).
  // Returns identity, labels, flags, timestamps, and aggregate submission/session counts only.
  // Config, rating prompts, and boards are excluded; boards stay reachable only through the
  // released-only season-boards route below.
  app.get<{ Querystring: { envId?: string } }>('/api/seasons', async (request, reply) => {
    const seasons = await deps.storage.listPublicSeasons({ envId: request.query.envId })
    return reply.code(200).send(seasons.map(publicSeasonView))
  })

  // Released seasons for an environment, newest first, for history links. Unreleased seasons
  // are filtered at the storage boundary (`includeUnreleased: false`).
  app.get<{ Params: { envId: string } }>(
    '/api/environments/:envId/seasons',
    async (request, reply) => {
      const seasons = await deps.storage.listSeasons(request.params.envId, {
        includeUnreleased: false,
      })
      return reply.code(200).send(seasons.map(seasonView))
    },
  )

  // The current released season and both its boards, plus the separate public submit and play
  // targets when they exist (reported even when unreleased). Empty current-board payload when nothing
  // is released yet.
  app.get<{ Params: { envId: string } }>(
    '/api/environments/:envId/leaderboards',
    async (request, reply) => {
      const envId = request.params.envId
      const [released, submissionTarget, playTarget] = await Promise.all([
        deps.storage.getReleasedSeason(envId),
        deps.storage.getOpenSubmissionSeason(envId),
        deps.storage.getPublicPlaySeason(envId),
      ])
      return reply.code(200).send({
        current:
          released === undefined
            ? null
            : {
                season: seasonView(released),
                board: await boardsFor(deps.storage, released.id),
              },
        submission_season_id: submissionTarget?.id ?? null,
        play_season_id: playTarget?.id ?? null,
      })
    },
  )

  // Both boards for a specific season, only when it is released. A 404 for an unreleased or unknown
  // season is the route-boundary guarantee that unreleased boards never reach the public.
  app.get<{ Params: { envId: string; seasonId: string } }>(
    '/api/environments/:envId/seasons/:seasonId/leaderboards',
    async (request, reply) => {
      const season = await deps.storage.getSeason(request.params.seasonId)
      if (
        season === undefined ||
        season.env_id !== request.params.envId ||
        season.release_status !== 'released'
      ) {
        return reply.code(404).send({ error: 'no such released season' })
      }
      return reply.code(200).send({
        season: seasonView(season),
        board: await boardsFor(deps.storage, season.id),
      })
    },
  )

  // An agent profile's automated placements: the released, Naive-free submitted-agent rows for one
  // owner. Built by gathering the owner's submissions for the environment and reading each one's
  // placements, so a resubmission's released history is included. The Naive baseline has no owner and
  // never appears here.
  app.get<{ Params: { envId: string; ownerId: string } }>(
    '/api/environments/:envId/agents/:ownerId/placements',
    async (request, reply) => {
      const { envId, ownerId } = request.params
      const [releasedSeasons, submissions] = await Promise.all([
        deps.storage.listSeasons(envId, { includeUnreleased: false }),
        deps.storage.listSubmissionsByUser(ownerId, envId),
      ])
      const releasedSeasonIds = new Set(releasedSeasons.map((season) => season.id))
      const placements = (
        await Promise.all(
          submissions.map((submission) =>
            deps.storage.listPlacementsByAgent(
              { kind: 'submission', submission_id: submission.id, user_id: ownerId },
              envId,
            ),
          ),
        )
      )
        .flat()
        .filter((placement) => releasedSeasonIds.has(placement.season_id))
      return reply.code(200).send({ env_id: envId, owner_id: ownerId, placements })
    },
  )
}
