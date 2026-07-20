import { createOfficialTickMarker, type KeyRegistry } from '../llm/key-registry.js'
import {
  type LlmGrant,
  type LlmLimits,
  type LlmModelConfig,
  type ModelAlias,
  modelCostWeights,
} from '../llm/types.js'
import { createOfficialRecordSink, type ExecutionTelemetryStore } from '../storage/llm/index.js'

/** A launch-scoped owner for the temporary official keys issued to one session container. */
export interface OfficialGrantLease {
  readonly keys: Readonly<Record<string, string>>
  /** Admission closes immediately; resolution is the abort/drain/reservation-finalizer barrier. */
  revoke(): Promise<void>
  /**
   * Cumulative in-flight LLM ms for this session (completed calls plus the current call's partial).
   * Used by outer watchdogs. Optional so existing lease fakes keep compiling.
   */
  inFlightMs?(): number
}

export interface IssueOfficialGrantsInput {
  /** Registry identity used for authentication, tick markers, and the revocation barrier. */
  sessionId: string
  /** SQLite execution-scope file: the live session id or the containing workflow run id. */
  scopeId: string
  /** Agent slot ids only. Human slots must be removed by the caller before this seam. */
  agentSlots: readonly string[]
  models: Partial<Record<ModelAlias, LlmModelConfig>>
  limits: LlmLimits
}

/** The narrow lifecycle dependency used by both launch owners. */
export interface OfficialGrantIssuer {
  issue(input: IssueOfficialGrantsInput): Promise<OfficialGrantLease>
}

/**
 * Bind official grants to the same durable store for both admission reads and successful-call writes.
 * Each slot reads only its own rows for the producing session. Workflow matches therefore share one
 * run-scoped SQLite file without accidentally sharing an allowance across games or slots.
 */
export function createOfficialGrantIssuer(
  registry: KeyRegistry,
  telemetry: ExecutionTelemetryStore,
): OfficialGrantIssuer {
  return {
    async issue(input): Promise<OfficialGrantLease> {
      telemetry.open(input.scopeId)
      const keys: Record<string, string> = {}
      const weights = modelCostWeights(input.models)
      try {
        for (const slot of input.agentSlots) {
          const tick = createOfficialTickMarker()
          const grant: LlmGrant = {
            kind: 'official',
            models: input.models,
            accountingScope: {
              key: `official:${input.sessionId}:${slot}`,
              limits: input.limits,
              weights,
              readCommittedUsage: () =>
                telemetry.readSessionUsageByModel(input.scopeId, input.sessionId, slot),
            },
            recordSink: createOfficialRecordSink(telemetry, {
              scopeId: input.scopeId,
              sessionId: input.sessionId,
              slot,
              tick,
            }),
          }
          keys[slot] = registry.issueOfficial(input.sessionId, grant, tick)
        }
      } catch (error) {
        // A later slot can fail after earlier keys were registered. Do not let a partially issued
        // launch escape until the same revocation barrier used by normal teardown has settled.
        await registry.revokeSession(input.sessionId)
        throw error
      }

      let revocation: Promise<void> | null = null
      return {
        keys,
        revoke(): Promise<void> {
          revocation ??= Promise.resolve(registry.revokeSession(input.sessionId))
          return revocation
        },
        inFlightMs(): number {
          return registry.inFlightMs(input.sessionId)
        },
      }
    },
  }
}
