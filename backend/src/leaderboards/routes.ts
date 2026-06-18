/**
 * The public leaderboard and history reads (Stage 6.3), separate from the operator `/api/admin`
 * prefix and ungated. The separation is the security boundary: every board/history read here serves
 * only `released` iterations at the route boundary, so an unreleased iteration's results cannot leak
 * through a public endpoint no matter the caller. A submission-open or play-open iteration is still
 * reported as a public target, since an open window makes an iteration reachable for submitting or
 * playing without exposing its boards.
 */
import type { FastifyInstance } from 'fastify'

import { iterationView } from '../iteration-views.js'
import type { Storage } from '../storage/index.js'

/** Everything the public leaderboard reads need. */
export interface LeaderboardDeps {
  storage: Storage
}

/** Read both boards for a released iteration: the automated aggregate and the human-rating aggregate. */
async function boardsFor(storage: Storage, iterationId: string) {
  const [automated, human] = await Promise.all([
    storage.getAutomatedBoard(iterationId),
    storage.getHumanBoard(iterationId),
  ])
  return { automated, human }
}

/** Register the public, released-only leaderboard and history routes. */
export function registerLeaderboardRoutes(app: FastifyInstance, deps: LeaderboardDeps): void {
  // Released iterations for an environment, newest first, for history links. Unreleased iterations
  // are filtered at the storage boundary (`includeUnreleased: false`).
  app.get<{ Params: { envId: string } }>(
    '/api/environments/:envId/iterations',
    async (request, reply) => {
      const iterations = await deps.storage.listIterations(request.params.envId, {
        includeUnreleased: false,
      })
      return reply.code(200).send(iterations.map(iterationView))
    },
  )

  // The current released iteration and both its boards, plus the separate public submit and play
  // targets when they exist (reported even when unreleased). Empty current-board payload when nothing
  // is released yet.
  app.get<{ Params: { envId: string } }>(
    '/api/environments/:envId/leaderboards',
    async (request, reply) => {
      const envId = request.params.envId
      const [released, submissionTarget, playTarget] = await Promise.all([
        deps.storage.getReleasedIteration(envId),
        deps.storage.getOpenSubmissionIteration(envId),
        deps.storage.getPublicPlayIteration(envId),
      ])
      return reply.code(200).send({
        current:
          released === undefined
            ? null
            : {
                iteration: iterationView(released),
                board: await boardsFor(deps.storage, released.id),
              },
        open_submission_iteration_id: submissionTarget?.id ?? null,
        play_open_iteration_id: playTarget?.id ?? null,
      })
    },
  )

  // Both boards for a specific iteration, only when it is released. A 404 for an unreleased or unknown
  // iteration is the route-boundary guarantee that unreleased boards never reach the public.
  app.get<{ Params: { envId: string; iterationId: string } }>(
    '/api/environments/:envId/iterations/:iterationId/leaderboards',
    async (request, reply) => {
      const iteration = await deps.storage.getIteration(request.params.iterationId)
      if (
        iteration === undefined ||
        iteration.env_id !== request.params.envId ||
        iteration.release_status !== 'released'
      ) {
        return reply.code(404).send({ error: 'no such released iteration' })
      }
      return reply.code(200).send({
        iteration: iterationView(iteration),
        board: await boardsFor(deps.storage, iteration.id),
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
      const [releasedIterations, submissions] = await Promise.all([
        deps.storage.listIterations(envId, { includeUnreleased: false }),
        deps.storage.listSubmissionsByUser(ownerId, envId),
      ])
      const releasedIterationIds = new Set(releasedIterations.map((iteration) => iteration.id))
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
        .filter((placement) => releasedIterationIds.has(placement.iteration_id))
      return reply.code(200).send({ env_id: envId, owner_id: ownerId, placements })
    },
  )
}
