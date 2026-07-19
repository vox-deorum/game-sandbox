import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { LlmOptions } from '../config.js'
import type { EnvironmentRegistry } from '../environments.js'
import type { UserStatus } from '../identity.js'
import { createDevelopmentRecordSink } from '../storage/llm/development-ledger/sink.js'
import type { DevelopmentLedgerStore } from '../storage/llm/development-ledger/store.js'
import type { LlmDevelopmentKey, Season } from '../storage/schema.js'
import { decodeSeasonConfig } from '../storage/season-config.js'
import { type EncodedLlmLimits, encodeLimits, type ResolvedLlm, resolveLlm } from './config.js'
import { LlmError } from './errors.js'
import type { LlmMeter } from './meter.js'
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
  llm: LlmOptions
  meter: LlmMeter
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

/** Persistent development credentials and per-request current-policy grant construction. */
export class DevelopmentKeyService {
  private readonly now: () => Date
  private readonly random: (bytes: number) => Buffer

  constructor(private readonly deps: DevelopmentKeyServiceDeps) {
    this.now = deps.now ?? (() => new Date())
    this.random = deps.random ?? randomBytes
  }

  async rotate(seasonId: string, userId: string): Promise<DevelopmentKeyResponse> {
    const resolved = await this.resolveSeason(seasonId)
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

  async authenticate(credential: string): Promise<LlmGrant> {
    const parsed = CREDENTIAL.exec(credential)
    if (parsed?.[1] === undefined || parsed[2] === undefined) throw invalidCredential()
    const row = await this.deps.storage.getDevelopmentKeyByKeyId(parsed[1])
    if (row === undefined || !verifySecret(parsed[2], row.secret_hash)) throw invalidCredential()

    const status = await this.deps.readUserStatus(row.user_id)
    if (status !== 'normal' && status !== 'admin') {
      throw new LlmError(403, 'account_not_active', 'The account is not active.')
    }
    const resolved = await this.resolveSeason(row.season_id)
    const scope = {
      key: `development:${row.season_id}:${row.user_id}`,
      limits: resolved.development,
      weights: modelCostWeights(resolved.models),
      readCommittedUsage: () => this.deps.ledger.readUserUsageByModel(row.season_id, row.user_id),
    }
    const sink = createDevelopmentRecordSink(this.deps.ledger, row.season_id, row.user_id)
    try {
      this.deps.ledger.open(row.season_id)
    } catch {
      // The shared meter owns single-flight, pair-scoped recovery. Breaker admission happens before
      // its durable read, so a broken season ledger cannot leak a raw storage error to this request.
      this.deps.meter.markUnavailable(scope, sink)
    }
    return {
      kind: 'development',
      models: resolved.models,
      accountingScope: scope,
      recordSink: sink,
    }
  }

  private async resolveSeason(seasonId: string): Promise<ResolvedLlm> {
    const season = await this.deps.storage.getSeason(seasonId)
    if (season === undefined) throw new LlmError(404, 'season_not_found', 'No such season.')
    const environment = this.deps.environments.get(season.env_id)
    if (environment === undefined) {
      throw new LlmError(403, 'llm_not_enabled', 'LLM access is not enabled for this season.')
    }
    if (season.submission_status !== 'open') {
      throw new LlmError(403, 'development_closed', 'Development access is closed for this season.')
    }
    const resolved = resolveLlm(this.deps.llm, environment, decodeSeasonConfig(season.config))
    if (!resolved.enabled) {
      throw new LlmError(403, 'llm_not_enabled', 'LLM access is not enabled for this season.')
    }
    return resolved
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
