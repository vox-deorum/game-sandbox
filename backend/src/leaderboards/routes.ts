/**
 * The public leaderboard and history reads (Stage 6.3), separate from the operator `/api/admin`
 * prefix and ungated. The separation is the security boundary: every board/history read here serves
 * only `released` seasons at the route boundary, so an unreleased season's results cannot leak
 * through a public endpoint no matter the caller. A submission-open or play-open season is still
 * reported as a public target, since an open window makes a season reachable for submitting or
 * playing without exposing its boards.
 */
import type { FastifyInstance } from 'fastify'
import type { RequestIdentity } from '../auth/identity.js'
import { enrichAgentRef, type UserDirectory } from '../auth/users.js'
import type { EnvironmentRegistry } from '../environments/registry.js'
import { resolveSeasonDisplaySettings } from '../environments/season-settings.js'
import type { ResolveLlmOptions } from '../llm/config.js'
import {
  agentOwnerIds,
  gameOwnerIds,
  publicSeasonView,
  runGameView,
  seasonView,
} from '../seasons/views.js'
import type { Storage } from '../storage/index.js'

/** Everything the public leaderboard reads need. */
export interface LeaderboardDeps {
  storage: Storage
  /** The identity seam gating the `includeUnreleased` season listing via `requireAdmin`. */
  identity: RequestIdentity
  /** The display-name directory; board rows and matchup seats batch owner ids through it. */
  userDirectory: UserDirectory
  /** The environment registry, read to enrich a built-in agent ref with its declared label. */
  environments: EnvironmentRegistry
  /** Deployment LLM configuration needed to resolve each season's effective display settings. */
  llm: ResolveLlmOptions
}

/**
 * Read both boards for a released season plus the matchup table: the automated aggregate, the
 * human-rating aggregate, and the per-game list of the latest completed run. The board shows one
 * representative (best-game) replay per agent; `games` is how a reader reaches every game of a
 * multi-seat matchup — each with its seats and its own replay link. Every submitted agent ref is
 * enriched with its owner's display name (one batched lookup per read) beside the stable id.
 */
async function boardsFor(deps: LeaderboardDeps, envId: string, seasonId: string) {
  // Resolve the latest completed run once and feed it into the board read: the board aggregates that
  // run and its games carry the per-matchup replay links, so passing the run keeps both on the
  // identical run and avoids resolving it twice. The human board derives its replay links from the
  // automated board, so it is computed after and passed in rather than aggregating the run again.
  const run = await deps.storage.getLatestCompletedRun(seasonId)
  const automated = await deps.storage.getAutomatedBoard(seasonId, run)
  const human = await deps.storage.getHumanBoard(seasonId, automated)
  const rawGames = run === undefined ? [] : await deps.storage.listRunGames(run.id)
  const names = await deps.userDirectory.namesFor([
    ...agentOwnerIds([...automated, ...human].map((row) => row.agent)),
    ...gameOwnerIds(rawGames),
  ])
  const meta = deps.environments.get(envId)
  return {
    automated: automated.map((row) => ({ ...row, agent: enrichAgentRef(row.agent, names, meta) })),
    human: human.map((row) => ({ ...row, agent: enrichAgentRef(row.agent, names, meta) })),
    games: rawGames.map((game) => runGameView(game, names, meta)),
  }
}

/** Register the public, released-only leaderboard and history routes. */
export function registerLeaderboardRoutes(app: FastifyInstance, deps: LeaderboardDeps): void {
  // Every public-facing season — released, submission-open, or play-open — newest first, for the
  // cross-game seasons list. Pass `?envId=` to narrow to a single environment (the hub uses this).
  // Returns identity, labels, flags, timestamps, and aggregate submission/session counts only.
  // Config, rating prompts, and boards are excluded; boards stay reachable only through the
  // released-only season-boards route below. Operators may pass `?includeUnreleased=true` to also
  // receive unreleased and fully-private seasons (the leaderboards page and admin console use this);
  // a non-operator who passes the flag is refused, mirroring the `/api/admin` gate.
  app.get<{ Querystring: { envId?: string; includeUnreleased?: string } }>(
    '/api/seasons',
    async (request, reply) => {
      const includeUnreleased = request.query.includeUnreleased === 'true'
      if (includeUnreleased) {
        const user = await deps.identity.requireAdmin(request, reply)
        if (user === undefined) {
          return reply
        }
      }
      const seasons = await deps.storage.listSeasons({
        envId: request.query.envId,
        scope: includeUnreleased ? 'all' : 'public',
      })
      return reply.code(200).send(seasons.map(publicSeasonView))
    },
  )

  // Released seasons for an environment, newest first, for history links. Unreleased seasons
  // are filtered at the storage boundary (`scope: 'released'`).
  app.get<{ Params: { envId: string } }>(
    '/api/environments/:envId/seasons',
    async (request, reply) => {
      const seasons = await deps.storage.listSeasons({
        envId: request.params.envId,
        scope: 'released',
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
      const meta = deps.environments.get(envId)
      if (meta === undefined) {
        return reply.code(404).send({ error: 'no such environment' })
      }
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
                settings: resolveSeasonDisplaySettings(meta, released, deps.llm),
                board: await boardsFor(deps, envId, released.id),
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
      const meta = deps.environments.get(season.env_id)
      if (meta === undefined) {
        return reply.code(404).send({ error: 'no such released season' })
      }
      return reply.code(200).send({
        season: seasonView(season),
        settings: resolveSeasonDisplaySettings(meta, season, deps.llm),
        board: await boardsFor(deps, season.env_id, season.id),
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
        deps.storage.listSeasons({ envId, scope: 'released' }),
        deps.storage.listSubmissionsByUser(ownerId, envId),
      ])
      const seasonLabels = new Map(releasedSeasons.map((season) => [season.id, season.label]))
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
        .filter((placement) => seasonLabels.has(placement.season_id))

      // The human-rating aggregate is computed live (it is never snapshotted into the placement
      // row), so look it up per season and match each placement's submission to its mean and count.
      const ratingsBySeason = new Map(
        await Promise.all(
          [...new Set(placements.map((placement) => placement.season_id))].map(
            async (seasonId) =>
              [seasonId, await deps.storage.aggregateRatingsByAgent(seasonId)] as const,
          ),
        ),
      )
      const enriched = placements.map((placement) => {
        const aggregate = ratingsBySeason
          .get(placement.season_id)
          ?.find(
            (row) =>
              row.agent.kind === 'submission' &&
              row.agent.submission_id === placement.agent_submission_id,
          )
        return {
          ...placement,
          season_label: seasonLabels.get(placement.season_id) ?? null,
          human_mean: aggregate?.mean ?? null,
          human_count: aggregate?.count ?? 0,
        }
      })
      return reply.code(200).send({ env_id: envId, owner_id: ownerId, placements: enriched })
    },
  )
}
