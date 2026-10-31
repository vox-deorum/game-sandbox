import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { UserStatus } from '../auth/identity.js'
import type { EnvironmentRegistry } from '../environments/registry.js'
import { createDevelopmentRecordSink } from '../storage/llm/development-ledger/sink.js'
import type { DevelopmentLedgerStore } from '../storage/llm/development-ledger/store.js'
import type { LlmDevelopmentKey, Season } from '../storage/schema.js'
import { decodeSeasonConfig } from '../storage/season-config.js'
import {
  type EncodedLlmLimits,
  encodeLimits,
  type ResolvedLlm,
  type ResolveLlmOptions,
  resolveLlm,
} from './config.js'
import { LlmError } from './errors.js'
import type { LlmGrant, ModelAlias } from './types.js'
import { MODEL_ALIASES, modelCostWeights } from './types.js'

const CREDENTIAL = /^sk-sandbox-dev-([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/

export interface DevelopmentKeyStorage {
  getSeason(id: string): Promise<Season | undefined>
  rotateDevelopmentKey(input: {
    seasonId: string
    userId: string
    keyId: string
    secretHash: string
    now: string
  }): Promise<LlmDevelopmentKey>
  getDevelopmentKeyByKeyId(keyId: string): Promise<LlmDevelopmentKey | undefined>
}

export interface DevelopmentKeyServiceDeps {
  storage: DevelopmentKeyStorage
  environments: EnvironmentRegistry
  llm: ResolveLlmOptions
  ledger: DevelopmentLedgerStore
  publicOrigin: string
  readUserStatus: (userId: string) => Promise<UserStatus | null>
  now?: () => Date
  random?: (bytes: number) => Buffer
}

export interface DevelopmentKeyResponse {
  season_id: string
  base_url: string
  api_key: string
  models: string[]
  cost_weights: Partial<Record<ModelAlias, number>>
  limits: EncodedLlmLimits
}

export interface DevelopmentReadPolicy {
  season: Season
  resolved: ResolvedLlm
}

/** A presented key's owner and the eligible season policy it was checked against. */
export interface VerifiedDevelopmentKey extends DevelopmentReadPolicy {
  userId: string
}

/** Persistent development credentials and per-request current-policy grant construction. */
export class DevelopmentKeyService {
  private readonly now: () => Date
  private readonly random: (bytes: number) => Buffer

  constructor(private readonly deps: DevelopmentKeyServiceDeps) {
    this.now = deps.now ?? (() => new Date())
    this.random = deps.random ?? randomBytes
  }

  async rotate(seasonId: string, userId: string): Promise<DevelopmentKeyResponse> {
    const { resolved } = await this.resolveEligibleSeason(seasonId)
    const keyId = this.random(18).toString('base64url')
    const secret = this.random(32).toString('base64url')
    await this.deps.storage.rotateDevelopmentKey({
      seasonId,
      userId,
      keyId,
      secretHash: hashSecret(secret).toString('hex'),
      now: this.now().toISOString(),
    })
    return {
      season_id: seasonId,
      base_url: `${this.deps.publicOrigin}/api/llm/v1`,
      api_key: `sk-sandbox-dev-${keyId}.${secret}`,
      models: MODEL_ALIASES.filter((alias) => resolved.models[alias] !== undefined),
      cost_weights: modelCostWeights(resolved.models),
      limits: encodeLimits(resolved.development),
    }
  }

  /** Check a presented key and its season's current eligibility without spending anything. */
  async verify(credential: string): Promise<VerifiedDevelopmentKey> {
    const parsed = CREDENTIAL.exec(credential)
    if (parsed?.[1] === undefined || parsed[2] === undefined) throw invalidCredential()
    const row = await this.deps.storage.getDevelopmentKeyByKeyId(parsed[1])
    if (row === undefined || !verifySecret(parsed[2], row.secret_hash)) throw invalidCredential()

    const status = await this.deps.readUserStatus(row.user_id)
    if (status !== 'normal' && status !== 'admin') {
      throw new LlmError(403, 'account_not_active', 'The account is not active.')
    }
    return { userId: row.user_id, ...(await this.resolveEligibleSeason(row.season_id)) }
  }

  async authenticate(credential: string): Promise<LlmGrant> {
    const { season, userId, resolved } = await this.verify(credential)
    const seasonId = season.id
    const scope = {
      key: `development:${seasonId}:${userId}`,
      limits: resolved.development,
      weights: modelCostWeights(resolved.models),
      verifyWritable: () => this.deps.ledger.open(seasonId),
      readCommittedUsage: () => this.deps.ledger.readUserUsageByModel(seasonId, userId),
    }
    const sink = createDevelopmentRecordSink(this.deps.ledger, seasonId, userId)
    return {
      kind: 'development',
      models: resolved.models,
      accountingScope: scope,
      recordSink: sink,
    }
  }

  /** Resolve the saved season and current deployment aliases without applying key eligibility. */
  async resolveReadPolicy(seasonId: string): Promise<DevelopmentReadPolicy> {
    const season = await this.deps.storage.getSeason(seasonId)
    if (season === undefined) throw new LlmError(404, 'season_not_found', 'No such season.')
    const environment = this.deps.environments.get(season.env_id)
    if (environment === undefined) {
      throw new LlmError(403, 'llm_not_enabled', 'LLM access is not enabled for this season.')
    }
    const resolved = resolveLlm(this.deps.llm, environment, decodeSeasonConfig(season.config))
    return { season, resolved }
  }

  private async resolveEligibleSeason(seasonId: string): Promise<DevelopmentReadPolicy> {
    const policy = await this.resolveReadPolicy(seasonId)
    const { season, resolved } = policy
    if (season.submission_status !== 'open') {
      throw new LlmError(403, 'development_closed', 'Development access is closed for this season.')
    }
    if (!resolved.enabled) {
      throw new LlmError(403, 'llm_not_enabled', 'LLM access is not enabled for this season.')
    }
    return policy
  }
}

function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest()
}

function verifySecret(secret: string, storedHex: string): boolean {
  const actual = hashSecret(secret)
  // A malformed stored hash compares against zeros (keeping the comparison constant-time) and is
  // rejected regardless of the comparison outcome.
  const validHex = /^[0-9a-f]{64}$/i.test(storedHex)
  const expected = validHex ? Buffer.from(storedHex, 'hex') : Buffer.alloc(actual.length)
  return timingSafeEqual(actual, expected) && validHex
}

function invalidCredential(): LlmError {
  return new LlmError(401, 'invalid_api_key', 'Invalid or revoked API key.')
}
