import type { FastifyInstance } from 'fastify'

import { decodeSeasonConfig, type Storage } from '../storage/index.js'
import { resolveSeasonParameters } from './parameters.js'
import type { EnvironmentRegistry } from './registry.js'

/** Dependencies for the public environment reads. */
export interface EnvironmentRouteDeps {
  environments: EnvironmentRegistry
  storage: Pick<Storage, 'getPublicPlaySeason'>
}

/** Register the public environment catalog and play-parameter routes. */
export function registerEnvironmentRoutes(app: FastifyInstance, deps: EnvironmentRouteDeps): void {
  app.get('/api/environments', () => deps.environments.list())

  app.get<{ Params: { envId: string } }>(
    '/api/environments/:envId/play-parameters',
    async (request, reply) => {
      const meta = deps.environments.get(request.params.envId)
      if (meta === undefined) {
        return reply.code(404).send({ error: 'no such environment' })
      }
      const season = await deps.storage.getPublicPlaySeason(meta.env_id)
      const resolved = resolveSeasonParameters(
        meta,
        season === undefined ? {} : decodeSeasonConfig(season.config).overrides?.parameters,
      )
      // A stored override the current declarations no longer accept is an operator problem, not a
      // reason to take play offline: the rejected override falls back to the environment default and
      // the remaining values are unaffected, so serve them and record the drift for the operator.
      if (resolved.issue !== undefined) {
        // The app is built with `logger: false`, so `request.log` would discard this.
        console.warn(
          `season ${season?.id} parameter override ${resolved.issue.name} ${resolved.issue.message}; using the environment default`,
        )
      }
      return { season_id: season?.id ?? null, values: resolved.values }
    },
  )
}
