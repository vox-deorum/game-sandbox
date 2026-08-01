import type { FastifyInstance } from 'fastify'

import type { LlmOptions } from '../config/config.js'
import { resolveLlm } from '../llm/config.js'
import { decodeSeasonConfig, type Storage } from '../storage/index.js'
import type { Season } from '../storage/schema.js'
import { resolveSeasonParameters, resolveSeasonRules, type SeasonParameters } from './parameters.js'
import type { EnvironmentMeta, EnvironmentRegistry } from './registry.js'

/** Dependencies for the public environment reads. */
export interface EnvironmentRouteDeps {
  environments: EnvironmentRegistry
  storage: Pick<Storage, 'getOpenSubmissionSeason' | 'getPublicPlaySeason'>
  templateRepoUrl: string
  llm: LlmOptions
}

function warnForParameterDrift(season: Season | undefined, resolved: SeasonParameters): void {
  if (resolved.issue === undefined) return
  // The app is built with `logger: false`, so `request.log` would discard this.
  console.warn(
    `season ${season?.id} parameter override ${resolved.issue.name} ${resolved.issue.message}; using the environment default`,
  )
}

/** Compare repository URLs without treating an optional trailing slash as a distinct repository. */
function sameTemplateRepository(left: string, right: string): boolean {
  return left.replace(/\/+$/, '') === right.replace(/\/+$/, '')
}

function seasonSettings(
  meta: EnvironmentMeta,
  season: Season,
  templateRepoUrl: string,
  llmOptions: LlmOptions,
) {
  const config = decodeSeasonConfig(season.config)
  const llmEnabled = resolveLlm(llmOptions, meta, config).enabled
  const resolved = resolveSeasonRules(meta, config.overrides, llmEnabled)
  warnForParameterDrift(season, resolved)
  const url = season.template_repo_url ?? templateRepoUrl
  return {
    season_id: season.id,
    season_label: season.label,
    template_repo: {
      url,
      branch: sameTemplateRepository(url, templateRepoUrl) ? `templates/${meta.env_id}` : null,
    },
    values: resolved.values,
    rules: resolved.rules,
  }
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
      warnForParameterDrift(season, resolved)
      return { season_id: season?.id ?? null, values: resolved.values }
    },
  )

  app.get<{ Params: { envId: string } }>(
    '/api/environments/:envId/season-settings',
    async (request, reply) => {
      const meta = deps.environments.get(request.params.envId)
      if (meta === undefined) {
        return reply.code(404).send({ error: 'no such environment' })
      }
      const [playSeason, submissionSeason] = await Promise.all([
        deps.storage.getPublicPlaySeason(meta.env_id),
        deps.storage.getOpenSubmissionSeason(meta.env_id),
      ])
      return {
        play:
          playSeason === undefined
            ? null
            : seasonSettings(meta, playSeason, deps.templateRepoUrl, deps.llm),
        submission:
          submissionSeason === undefined
            ? null
            : seasonSettings(meta, submissionSeason, deps.templateRepoUrl, deps.llm),
      }
    },
  )
}
