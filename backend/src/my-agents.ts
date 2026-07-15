/**
 * The signed-in participant's compact season summary. This endpoint deliberately assembles the
 * whole response from three batched reads, so adding seasons or submissions never creates request
 * query fan-out.
 */
import type { FastifyInstance } from 'fastify'

import type { RequestIdentity } from './identity.js'
import type {
  AutomatedPlacement,
  PublicSeason,
  Storage,
  Submission,
  SubmissionStatus,
} from './storage/index.js'

interface MyAgentsDeps {
  storage: Storage
  identity: RequestIdentity
}

interface SubmissionSummary {
  id: string
  status: SubmissionStatus
  submitted_at: string
}

interface SeasonSummary {
  id: string
  label: string | null
  created_at: string
  release_status: 'unreleased' | 'released'
  submission: SubmissionSummary | null
  mean_score: number | null
}

interface EnvironmentSummary {
  env_id: string
  current_season: SeasonSummary | null
  previous_seasons: SeasonSummary[]
}

/** Return the first value for a key, preserving the source query's canonical newest-first order. */
function firstBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T> {
  const result = new Map<string, T>()
  for (const row of rows) {
    const rowKey = key(row)
    if (!result.has(rowKey)) {
      result.set(rowKey, row)
    }
  }
  return result
}

function seasonSummary(
  season: PublicSeason,
  activeSubmission: Submission | undefined,
  placement: AutomatedPlacement | undefined,
): SeasonSummary {
  return {
    id: season.id,
    label: season.label,
    created_at: season.created_at,
    release_status: season.release_status,
    submission:
      activeSubmission === undefined
        ? null
        : {
            id: activeSubmission.id,
            status: activeSubmission.status,
            submitted_at: activeSubmission.created_at,
          },
    // A retained placement becomes private again when an operator un-releases the season.
    mean_score: season.release_status === 'released' ? (placement?.mean_score ?? null) : null,
  }
}

export function registerMyAgentRoutes(app: FastifyInstance, deps: MyAgentsDeps): void {
  app.get('/api/my/agents', async (request, reply) => {
    const user = await deps.identity.requireUser(request, reply)
    if (user === undefined) {
      return
    }

    const [submissions, seasons, placements] = await Promise.all([
      deps.storage.listSubmissionsByUser(user.id),
      deps.storage.listSeasons({ scope: 'all' }),
      deps.storage.listPlacementsByUser(user.id),
    ])

    // Never fall back to an older superseded attempt. A season without a non-superseded row is
    // represented as not submitted even if historical attempts happen to remain.
    const activeBySeason = firstBy(
      submissions.filter((submission) => submission.superseded_at === null),
      (submission) => submission.season_id,
    )
    // Placement rows are attributed to the owner separately from the currently active attempt, so a
    // run followed by a resubmission still shows the score earned by the attempt that actually ran.
    const placementBySeason = firstBy(placements, (placement) => placement.season_id)
    const submittedSeasonIds = new Set(submissions.map((submission) => submission.season_id))
    const currentByEnvironment = firstBy(
      seasons.filter((season) => season.submission_status === 'open'),
      (season) => season.env_id,
    )

    // Follow canonical season order for both environment discovery and each environment's history.
    const environmentIds: string[] = []
    const seenEnvironmentIds = new Set<string>()
    for (const season of seasons) {
      if (
        !seenEnvironmentIds.has(season.env_id) &&
        (season.submission_status === 'open' || submittedSeasonIds.has(season.id))
      ) {
        seenEnvironmentIds.add(season.env_id)
        environmentIds.push(season.env_id)
      }
    }

    return environmentIds.map((envId): EnvironmentSummary => {
      const current = currentByEnvironment.get(envId)
      const previous = seasons
        .filter(
          (season) =>
            season.env_id === envId &&
            season.id !== current?.id &&
            submittedSeasonIds.has(season.id),
        )
        .slice(0, 3)
      return {
        env_id: envId,
        current_season:
          current === undefined
            ? null
            : seasonSummary(
                current,
                activeBySeason.get(current.id),
                placementBySeason.get(current.id),
              ),
        previous_seasons: previous.map((season) =>
          seasonSummary(season, activeBySeason.get(season.id), placementBySeason.get(season.id)),
        ),
      }
    })
  })
}
