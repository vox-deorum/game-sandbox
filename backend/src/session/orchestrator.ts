/**
 * The session orchestrator: the lifecycle owner above the execution driver.
 *
 * It depends only on the driver interface, the storage interface, the environment registry, and
 * config, so its tests run on a fake driver with no Docker anywhere. Starting a session validates
 * the request and the one-per-user rule, resolves the overrides, ensures the image, records the
 * row, and launches one container with the driver-neutral sandbox profile and the session-config
 * argv. From there each session drives itself as a {@link LiveSession}; the orchestrator only
 * resolves attach and stop against the registry.
 */
import { randomInt, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import {
  type ParameterValue,
  resolveLayout,
  validateCompleteParameters,
} from '@game-sandbox/schema/environment'
import type { UserDirectory } from '../auth/users.js'
import type { Config } from '../config.js'
import { currentSessionBaseImageSpec } from '../deps-version.js'
import type { ExecutionDriver, ImageRef } from '../driver/index.js'
import { buildSandboxProfile, sandboxResourcesForPlayers } from '../driver/sandbox.js'
import type { EnvironmentMeta, EnvironmentRegistry } from '../environments.js'
import { resolveLlm as defaultResolveLlm } from '../llm/config.js'
import { optionalField } from '../optional-field.js'
import { decodeSeasonConfig, type Storage, type Submission } from '../storage/index.js'
import type { Season, Session, SessionMode } from '../storage/schema.js'
import type { SubmissionSnapshotStore } from '../submission/snapshot-store.js'
import type { SubmissionSource } from '../submission/source/index.js'
import {
  resolveSubmissionLaunchImage,
  type SessionImageSeat,
  submissionSeatPath,
} from '../submission/submission-image.js'
import { assembleLaunch, assembleLlmLaunchConfig, type SeatBinding } from './launch-config.js'
import {
  type Attachment,
  type ClientSocket,
  ensureRecordingsDir,
  LiveSession,
} from './live-session.js'
import type { OfficialGrantIssuer, OfficialGrantLease } from './official-grants.js'
import { SessionRegistry } from './registry.js'

/** Where the recordings volume is mounted inside every session container. */
const CONTAINER_RECORDINGS_DIR = '/recordings'
/** Grace given to a container to end politely before the driver hard-kills it. */
const KILL_GRACE_MS = 5_000
/** This stage's single-human session-composition cap; later multi-human play relaxes it. */
const MAX_HUMAN_PLAYERS = 1

/** One ordinary agent binding accepted for a seat or a future human companion. */
export type AgentSeatAssignment =
  | { kind: 'builtin-agent' }
  | { kind: 'submission'; submissionId: string }

/**
 * One seat's assignment in a start request. A human may carry an ordinary companion binding so the
 * request contract is ready for wide seats. Singleton seats reject that unnecessary companion.
 */
export type SeatAssignment =
  | AgentSeatAssignment
  | { kind: 'human'; companion?: AgentSeatAssignment }

/**
 * A start request, already attributed to a user by the HTTP layer's identity resolution. The session
 * shape is an explicit per-seat assignment: every required seat names what fills it, and the
 * human-versus-scripted `mode` is derived from whether any seat is `human`, not sent.
 */
export interface StartRequest {
  userId: string
  envId: string
  seed?: number
  humanTimeoutMs?: number
  /** The play-open season the start form was prefetched against. */
  seasonId: string
  /** The complete resolved parameter map, including hidden and synthesized values. */
  parameters: Record<string, ParameterValue>
  /** Per-seat assignment keyed by seat id; must cover exactly the resolved layout. */
  seats: Record<string, SeatAssignment>
}

/** Which submission fills which seat and singleton player in this stage. */
interface SubmissionBinding {
  submissionId: string
  seatId: string
  path: string
  /** The submission owner, attributed to the player in the recording header. */
  userId: string
}

/**
 * A seat after validation. A `submission` seat carries its loaded row; human and built-in seats carry
 * none. The discriminated union lets config assembly and image resolution read the submission without
 * a presence check. A human seat also carries the one player the person controls, chosen once during
 * seat validation so no later stage repeats the choice.
 */
type ResolvedAgentBinding =
  | { kind: 'builtin-agent' }
  | { kind: 'submission'; submission: Submission }

type ResolvedSeat =
  | { seatId: string; kind: 'human'; playerId: string; companion?: ResolvedAgentBinding }
  | ({ seatId: string } & ResolvedAgentBinding)

interface ValidatedSeatAssignment {
  seatId: string
  assignment: SeatAssignment
  /** Set only for a human assignment: the seat's first human-capable member, in declared order. */
  humanPlayer?: string
}

/** What the HTTP layer returns to a client that started a session. */
export interface StartResult {
  id: string
  wsPath: string
}

/**
 * A start/stop failure carrying the HTTP status the route should map it to, an optional stable
 * machine code the frontend branches on (e.g. `already_active`), and optional details merged into the
 * error body (the active session id for the rejoin path).
 */
export class OrchestratorError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

/**
 * Everything the {@link Orchestrator} depends on. An options object rather than a positional list so a
 * new dependency is a named field a call site must acknowledge, not a trailing argument a caller can
 * silently omit (which would compile clean and quietly degrade, e.g. recordings losing their display
 * names). The four required seams come first; the rest are optional with sensible defaults.
 */
export interface OrchestratorDeps {
  driver: ExecutionDriver
  storage: Storage
  environments: EnvironmentRegistry
  config: Config
  log?: (message: string) => void
  /**
   * Called after a session finalizes and its recording row is written, so retention can sweep the
   * just-grown data. Defaults to a no-op for tests that do not exercise retention; main wires it to the
   * retention sweep.
   */
  onSessionFinalized?: (id: string) => void
  /**
   * The submission-source seam, the fallback to refetch a pre-snapshot submission when rebuilding its
   * overlay. Optional: a deployment or test that never runs a submitted-agent watch session can omit it
   * (together with the snapshot store), and a `submissionId` run then fails cleanly.
   */
  submissionSource?: SubmissionSource
  /**
   * The snapshot store an evicted overlay is rebuilt from. Paired with {@link OrchestratorDeps.submissionSource}:
   * both are present for a deployment that runs submitted agents, both omitted otherwise.
   */
  submissionSnapshots?: SubmissionSnapshotStore
  /**
   * The display-name directory the recording-header attribution snapshots names through at launch.
   * Optional: without it (or for an id with no row) every label falls back to the stable id.
   */
  userDirectory?: UserDirectory
  /** Issues launch-scoped official keys when the resolved live policy enables LLM access. */
  officialGrantIssuer?: OfficialGrantIssuer
  /** Reclaims settled live scopes that never gained a durable recording association. */
  deleteLlmScope?: (scopeId: string) => void
  /** Injectable current-policy resolver; defaults to the deployment/environment/season resolver. */
  resolveLiveLlm?: typeof defaultResolveLlm
}

export class Orchestrator {
  private readonly registry = new SessionRegistry()
  private readonly driver: ExecutionDriver
  private readonly storage: Storage
  private readonly environments: EnvironmentRegistry
  private readonly config: Config
  private readonly log: (message: string) => void
  private readonly onSessionFinalized: (id: string) => void
  private readonly submissionSource?: SubmissionSource
  private readonly submissionSnapshots?: SubmissionSnapshotStore
  private readonly userDirectory?: UserDirectory
  private readonly officialGrantIssuer?: OfficialGrantIssuer
  private readonly deleteLlmScope?: (scopeId: string) => void
  private readonly resolveLiveLlm: typeof defaultResolveLlm

  constructor(deps: OrchestratorDeps) {
    this.driver = deps.driver
    this.storage = deps.storage
    this.environments = deps.environments
    this.config = deps.config
    this.log = deps.log ?? (() => {})
    this.onSessionFinalized = deps.onSessionFinalized ?? (() => {})
    this.submissionSource = deps.submissionSource
    this.submissionSnapshots = deps.submissionSnapshots
    this.userDirectory = deps.userDirectory
    this.officialGrantIssuer = deps.officialGrantIssuer
    this.deleteLlmScope = deps.deleteLlmScope
    this.resolveLiveLlm = deps.resolveLiveLlm ?? defaultResolveLlm
  }

  /**
   * Start a session from an explicit per-seat assignment. Validate the shape authoritatively
   * (every required seat assigned, humans only in human-capable seats, at most one human this stage),
   * derive the human-versus-scripted `mode` from it, enforce one per user, resolve the seed and
   * human timeout, ensure the image, insert the `starting` row, record one `session_submissions`
   * row per submitted seat, and launch the container. All validation runs before any container starts.
   */
  async start(request: StartRequest): Promise<StartResult> {
    // Validate the request first (a malformed start is a 400 regardless of identity), then the
    // one-per-user rule (409). Authorization (an active user) is enforced by the route guard before
    // the orchestrator is called, so there is no allowlist check here.
    const meta = this.environments.get(request.envId)
    if (meta === undefined) {
      throw new OrchestratorError(400, `unknown environment ${request.envId}`)
    }
    // Every session attaches to a play-open season. Ratings hang off it, and each submitted seat must
    // reference an active `ready` submission on it — so a play-closed environment never starts an
    // unattributable session. Resolve and require it once, before any submission or image work.
    const playSeason = await this.storage.getPublicPlaySeason(meta.env_id)
    if (playSeason === undefined) {
      throw new OrchestratorError(
        409,
        'no season is open for public play in this environment',
        'no_play_open_season',
      )
    }
    if (request.seasonId !== playSeason.id) {
      throw new OrchestratorError(
        409,
        'the play-open season changed while this page was open',
        'play_season_changed',
      )
    }
    const seasonConfig = decodeSeasonConfig(playSeason.config)
    // The start form prefetched the season's resolved values and applied the player's edits, so the
    // submitted map already carries the season layer. Validating it against the current declarations
    // is the whole check: re-applying the stored overrides underneath a complete map could not change
    // a single value, and would only let an override the environment no longer accepts fail a start
    // the player got right.
    const resolvedParameters = validateCompleteParameters(meta.parameters, request.parameters)
    const parameterIssue = resolvedParameters.issues[0]
    if (parameterIssue !== undefined) {
      throw new OrchestratorError(
        400,
        `invalid parameters: ${parameterIssue.name} ${parameterIssue.message}`,
        'invalid_parameters',
      )
    }
    const layout = resolveLayout(meta, resolvedParameters.values)
    const { assignments, mode } = this.validateSeatShape(meta, request.seats, layout)

    const activeId = this.registry.activeIdForUser(request.userId)
    if (activeId !== undefined) {
      throw new OrchestratorError(409, 'user already has an active session', 'already_active', {
        active_session_id: activeId,
      })
    }
    const resolvedSeats = await this.resolveSubmissions(assignments, meta, playSeason)

    // Resolve the human timeout once, accounting for mode: only a human session has one. This value
    // is used in both the database row and the container config, so they must agree.
    const humanTimeoutMs =
      mode === 'human'
        ? request.humanTimeoutMs !== undefined
          ? request.humanTimeoutMs
          : meta.human_timeout_ms
        : null
    const seed = request.seed ?? randomInt(0, 2 ** 31)

    // Resolve the play-open season's overrides once, and from them the effective messaging rules:
    // enabled is the environment metadata AND the season override; the cap is the minimum of the two.
    // The same resolved block is handed to all three consumers (the container config, the relay, and
    // the session row) so live and reopened-ended payloads agree, and it is persisted on the row.
    const overrides = seasonConfig.overrides
    const messaging = resolveMessaging(meta, overrides?.messaging)
    const llm = this.resolveLiveLlm(this.config.llm, meta, seasonConfig)
    const externalPlayers = resolvedSeats.flatMap((seat) =>
      seat.kind === 'human' ? [seat.playerId] : [],
    )

    const id = randomUUID()
    const recordingId = `${meta.env_id}-${id}`
    const createdAt = new Date().toISOString()
    let llmLease: OfficialGrantLease | undefined
    if (llm.enabled) {
      if (this.officialGrantIssuer === undefined) {
        throw new OrchestratorError(500, 'official LLM grants are not configured')
      }
      try {
        llmLease = await this.officialGrantIssuer.issue({
          sessionId: id,
          scopeId: id,
          agentPlayers: layout.seats.flatMap((seat) =>
            seat.players.filter((playerId) => !externalPlayers.includes(playerId)),
          ),
          models: llm.models,
          limits: llm.official,
        })
      } catch (error) {
        this.deleteUnusedLlmScope(id)
        throw new OrchestratorError(500, `failed to issue official LLM grants: ${String(error)}`)
      }
    }

    // Resolve the launch image from the validated submitted seats: the base image when none, a single
    // submission's cached overlay, or a composed multi-submission session image.
    let image: ImageRef
    let submissionBindings: SubmissionBinding[]
    try {
      ;({ image, submissionBindings } = await this.resolveImage(resolvedSeats, playSeason))
      await this.storage.createSession({
        id,
        user_id: request.userId,
        env_id: meta.env_id,
        mode,
        recording_id: recordingId,
        season_id: playSeason.id,
        human_timeout_ms: humanTimeoutMs,
        messaging_enabled: messaging.enabled ? 1 : 0,
        message_cap: messaging.cap,
        llm_enabled: llm.enabled ? 1 : 0,
        parameters: resolvedParameters.values,
        created_at: createdAt,
      })
    } catch (error) {
      await llmLease?.revoke()
      this.deleteUnusedLlmScope(id)
      throw error
    }

    let sandbox: ReturnType<typeof buildSandboxProfile>
    let sessionConfig: Record<string, unknown>
    try {
      sandbox = buildSandboxProfile(
        sandboxResourcesForPlayers(this.config.sandbox, layout.playerCount),
        [
          {
            hostPath: this.recordingsHostDir(),
            containerPath: CONTAINER_RECORDINGS_DIR,
            readOnly: false,
          },
        ],
        llm.enabled ? 'llm' : 'none',
      )
      sessionConfig = await this.sessionConfig(
        meta,
        seed,
        humanTimeoutMs,
        recordingId,
        resolvedSeats,
        layout,
        request.userId,
        overrides,
        resolvedParameters.values,
        messaging,
        llmLease?.keys ?? {},
      )
      await ensureRecordingsDir(this.recordingsHostDir())
    } catch (error) {
      await llmLease?.revoke()
      this.deleteUnusedLlmScope(id)
      await this.storage.markEnded(id, 'error', new Date().toISOString()).catch(() => undefined)
      throw new OrchestratorError(500, `failed to prepare session launch: ${String(error)}`)
    }

    let process: Awaited<ReturnType<ExecutionDriver['launch']>>
    try {
      process = await this.driver.launch({
        image,
        argv: [JSON.stringify(sessionConfig)],
        sandbox,
        sessionId: id,
      })
    } catch (error) {
      // The row exists but no container does; mark it failed so it never looks active. No
      // session_submissions rows have been written yet (they land only after a successful launch,
      // below), so a launch that never started leaves no phantom "recent run" on any submission.
      await llmLease?.revoke()
      this.deleteUnusedLlmScope(id)
      await this.storage.markEnded(id, 'error', new Date().toISOString()).catch(() => undefined)
      throw new OrchestratorError(500, `failed to launch session: ${String(error)}`)
    }

    // The container is running: record one attribution row per submitted seat, so the agent profile
    // can list each as a recent run. Human and built-in seats are carried only in the recording header
    // `players`, never here. Done after launch so a failed launch attributes no run to anyone.
    try {
      for (const binding of submissionBindings) {
        await this.storage.recordSessionSubmission(id, binding.submissionId, binding.seatId)
      }
    } catch (error) {
      // The post-launch writes (attribution rows) failed, but the container is running. Kill it and
      // mark the session ended so it never looks active and no LiveSession will try to manage it.
      await llmLease?.revoke()
      try {
        await process.kill(KILL_GRACE_MS)
      } catch {
        // Best-effort kill; the process may have already exited.
      }
      await this.storage.markEnded(id, 'error', new Date().toISOString()).catch(() => undefined)
      this.deleteUnusedLlmScope(id)
      throw new OrchestratorError(500, `failed to record session attribution: ${String(error)}`)
    }

    const session = new LiveSession({
      id,
      userId: request.userId,
      envId: meta.env_id,
      mode,
      recordingId,
      createdAt,
      process,
      externalPlayers,
      messaging,
      llmEnabled: llm.enabled,
      deps: {
        storage: this.storage,
        onEnd: (endedId) => this.registry.remove(endedId),
        onFinalized: (endedId) => this.onSessionFinalized(endedId),
        log: this.log,
        idleTimeoutMs: this.config.sessionIdleTimeoutMs,
        maxDurationMs: this.config.sessionMaxDurationMs,
        killGraceMs: KILL_GRACE_MS,
        revokeLlm: () => llmLease?.revoke() ?? Promise.resolve(),
        llmInFlightMs: () => llmLease?.inFlightMs?.() ?? 0,
        deleteLlmScope: this.deleteLlmScope,
      },
    })
    this.registry.add(session)

    return { id, wsPath: `/api/sessions/${id}/ws` }
  }

  private deleteUnusedLlmScope(scopeId: string): void {
    try {
      this.deleteLlmScope?.(scopeId)
    } catch (error) {
      this.log(`session ${scopeId}: deleting unused LLM scope failed: ${String(error)}`)
    }
  }

  /** Validate an assignment against the resolver's exact ordered seat set and derive session mode. */
  private validateSeatShape(
    meta: EnvironmentMeta,
    seats: Record<string, SeatAssignment>,
    layout: ReturnType<typeof resolveLayout>,
  ): { assignments: ValidatedSeatAssignment[]; mode: SessionMode } {
    const requiredIds = layout.seats.map((seat) => seat.seatId)
    const required = new Set(requiredIds)
    for (const seatId of Object.keys(seats)) {
      if (!required.has(seatId)) {
        throw new OrchestratorError(400, `unknown seat ${seatId} for environment ${meta.env_id}`)
      }
    }

    const humanCapable = new Set(meta.human_players)
    let humanCount = 0
    const assignments = layout.seats.map((seat) => {
      const assignment = seats[seat.seatId]
      if (assignment === undefined) {
        throw new OrchestratorError(400, `missing assignment for required seat ${seat.seatId}`)
      }
      if (assignment.kind === 'human') {
        const humanPlayer = seat.players.find((candidate) => humanCapable.has(candidate))
        if (humanPlayer === undefined) {
          throw new OrchestratorError(
            400,
            `seat ${seat.seatId} is not human-controllable in environment ${meta.env_id}`,
          )
        }
        if (seat.players.length === 1 && assignment.companion !== undefined) {
          throw new OrchestratorError(400, `singleton seat ${seat.seatId} cannot have a companion`)
        }
        if (seat.players.length > 1 && assignment.companion === undefined) {
          throw new OrchestratorError(400, `wide seat ${seat.seatId} requires a companion`)
        }
        humanCount += 1
        return { seatId: seat.seatId, assignment, humanPlayer }
      }
      return { seatId: seat.seatId, assignment }
    })
    if (humanCount > MAX_HUMAN_PLAYERS) {
      throw new OrchestratorError(
        400,
        `at most ${MAX_HUMAN_PLAYERS} human player is allowed, got ${humanCount}`,
      )
    }
    return { assignments, mode: humanCount > 0 ? 'human' : 'scripted' }
  }

  /**
   * Load and validate the submission behind each `submission` seat (404 unknown, 400 wrong
   * environment, 409 not `ready`, 409 not active for the play-open season), leaving human and built-in
   * seats untouched. Returns the seats in assignment order with the loaded submission attached.
   */
  private async resolveSubmissions(
    assignments: ValidatedSeatAssignment[],
    meta: EnvironmentMeta,
    playSeason: Season,
  ): Promise<ResolvedSeat[]> {
    const resolved: ResolvedSeat[] = []
    for (const { seatId, assignment, humanPlayer } of assignments) {
      if (assignment.kind === 'human') {
        if (humanPlayer === undefined) {
          throw new Error(`human seat ${seatId} was validated without a player`)
        }
        const companion =
          assignment.companion === undefined
            ? undefined
            : await this.resolveAgentBinding(assignment.companion, meta, playSeason)
        resolved.push({
          seatId,
          kind: 'human',
          playerId: humanPlayer,
          ...optionalField('companion', companion),
        })
        continue
      }
      resolved.push({ seatId, ...(await this.resolveAgentBinding(assignment, meta, playSeason)) })
    }
    return resolved
  }

  private async resolveAgentBinding(
    assignment: AgentSeatAssignment,
    meta: EnvironmentMeta,
    playSeason: Season,
  ): Promise<ResolvedAgentBinding> {
    if (assignment.kind === 'builtin-agent') return { kind: 'builtin-agent' }
    const submission = await this.storage.getSubmission(assignment.submissionId)
    if (submission === undefined) {
      throw new OrchestratorError(404, `no such submission ${assignment.submissionId}`)
    }
    if (submission.env_id !== meta.env_id) {
      throw new OrchestratorError(
        400,
        'submission is for a different environment',
        'submission_env_mismatch',
      )
    }
    if (submission.status !== 'ready') {
      throw new OrchestratorError(409, 'submission is not ready to run', 'submission_not_ready')
    }
    // Only the play-open season's active submissions are runnable choices. The submission window may
    // already point at the next round, while the previous round remains the public play target.
    if (submission.season_id !== playSeason.id || submission.superseded_at !== null) {
      throw new OrchestratorError(
        409,
        'submission is not active for the play-open season',
        'submission_not_active',
      )
    }
    return { kind: 'submission', submission }
  }

  /**
   * Resolve the launch image and submission attribution once per submitted seat. A human companion
   * is part of its human seat and shares that seat's staged overlay across its nonhuman players.
   */
  private async resolveImage(
    resolvedSeats: ResolvedSeat[],
    playSeason: Season,
  ): Promise<{ image: ImageRef; submissionBindings: SubmissionBinding[] }> {
    const composed: SessionImageSeat[] = []
    const submissionBindings: SubmissionBinding[] = []
    for (const seat of resolvedSeats) {
      const submission =
        seat.kind === 'submission'
          ? seat.submission
          : seat.kind === 'human' && seat.companion?.kind === 'submission'
            ? seat.companion.submission
            : undefined
      if (submission === undefined) {
        continue
      }
      composed.push({ seatId: seat.seatId, submission })
      submissionBindings.push({
        submissionId: submission.id,
        seatId: seat.seatId,
        path: submissionSeatPath(seat.seatId),
        userId: submission.user_id,
      })
    }

    if (composed.length === 0) {
      return {
        image: await this.driver.ensureImage(currentSessionBaseImageSpec()),
        submissionBindings,
      }
    }
    if (this.submissionSource === undefined || this.submissionSnapshots === undefined) {
      throw new OrchestratorError(500, 'submitted-agent runs are not configured on this deployment')
    }
    const imageDeps = {
      driver: this.driver,
      snapshots: this.submissionSnapshots,
      source: this.submissionSource,
      imagePolicy: this.config.docker.imagePolicy,
    }
    const depsVersion = decodeSeasonConfig(playSeason.config).deps_version
    // The single-versus-composed decision is shared with the workflow runner so the two cannot drift.
    const image = await resolveSubmissionLaunchImage(imageDeps, composed, depsVersion)
    return { image, submissionBindings }
  }

  /**
   * Attach a socket to a live session, or `undefined` if no such session is running. `userId` is the
   * spectator's resolved id, or `null` for an anonymous socket; only a non-null id matching the
   * session owner attaches with controls, so an anonymous socket always spectates.
   */
  attach(sessionId: string, socket: ClientSocket, userId: string | null): Attachment | undefined {
    const session = this.registry.get(sessionId)
    if (session === undefined) {
      return undefined
    }
    return session.attach(socket, userId !== null && session.userId === userId)
  }

  /** Owner-only graceful stop. 404 when unknown, 403 when not the owner; a no-op once ended. */
  async stop(sessionId: string, userId: string): Promise<void> {
    const session = this.registry.get(sessionId)
    if (session === undefined) {
      const row = await this.storage.getSession(sessionId)
      if (row === undefined) {
        throw new OrchestratorError(404, 'no such session')
      }
      if (row.user_id !== userId) {
        throw new OrchestratorError(403, 'not your session')
      }
      return
    }
    if (session.userId !== userId) {
      throw new OrchestratorError(403, 'not your session')
    }
    await session.requestStop()
  }

  /** The persisted row for a session, or `undefined`. */
  getSession(sessionId: string): Promise<Session | undefined> {
    return this.storage.getSession(sessionId)
  }

  /** Tear down every live session — the process is shutting down. */
  async shutdown(): Promise<void> {
    await Promise.all(this.registry.all().map((session) => session.finalize('stopped')))
  }

  private recordingsHostDir(): string {
    return resolve(this.config.recordingsDir)
  }

  /**
   * Build the session config the container reads from argv from the validated seat assignments. Each
   * player maps to its seat: a connected human (driven by the transport), the built-in Naive
   * baseline, or a submitted agent carrying the overlay path the harness loads its code from. The
   * shared seam produces the `player_bindings`/`players` wire blocks the headless workflow runner
   * builds the same way.
   * Environment facts (pace, limits, the default human timeout) live in the in-image registry, so only
   * the overrides travel here.
   */
  private async sessionConfig(
    meta: EnvironmentMeta,
    seed: number,
    humanTimeoutMs: number | null,
    recordingId: string,
    resolvedSeats: ResolvedSeat[],
    layout: ReturnType<typeof resolveLayout>,
    ownerUserId: string,
    overrides: ReturnType<typeof decodeSeasonConfig>['overrides'],
    parameters: Record<string, ParameterValue>,
    messaging: { enabled: boolean; cap: number | null },
    llmKeys: Readonly<Record<string, string>>,
  ): Promise<Record<string, unknown>> {
    // Snapshot display names for the recording header at launch time: the human seat's user and every
    // submission owner, one batched lookup. Names are cosmetic — the label falls back to the stable id —
    // so a directory failure must never abort a launch (the row is already inserted); degrade to ids.
    const names = await this.snapshotNames(ownerUserId, resolvedSeats)
    const seats = new Map<string, SeatBinding>()
    for (const seat of resolvedSeats) {
      if (seat.kind === 'human') {
        const companion = seat.companion
        seats.set(seat.seatId, {
          driver: 'human',
          playerId: seat.playerId,
          userId: ownerUserId,
          ...optionalField('displayName', names.get(ownerUserId)),
          ...optionalField(
            'companion',
            companion === undefined
              ? undefined
              : companion.kind === 'submission'
                ? {
                    driver: 'submission' as const,
                    submissionId: companion.submission.id,
                    userId: companion.submission.user_id,
                    path: submissionSeatPath(seat.seatId),
                    ...optionalField('ownerName', names.get(companion.submission.user_id)),
                  }
                : { driver: 'naive' as const },
          ),
        })
      } else if (seat.kind === 'submission') {
        seats.set(seat.seatId, {
          driver: 'submission',
          submissionId: seat.submission.id,
          userId: seat.submission.user_id,
          path: submissionSeatPath(seat.seatId),
          ...optionalField('ownerName', names.get(seat.submission.user_id)),
        })
      } else {
        seats.set(seat.seatId, { driver: 'naive' })
      }
    }
    const { playerBindings, players } = assembleLaunch(seats, layout)
    return {
      env_id: meta.env_id,
      seed,
      player_bindings: playerBindings,
      human_timeout_ms: humanTimeoutMs,
      recording_dir: CONTAINER_RECORDINGS_DIR,
      recording_id: recordingId,
      parameters,
      players,
      // Carry the resolved effective messaging block; the harness re-combines defensively, so this
      // double application is idempotent (AND and min).
      messaging_enabled: messaging.enabled,
      message_cap: messaging.cap,
      ...assembleLlmLaunchConfig(this.config.llm.internalPort, llmKeys),
      // The owner decision: the play-open season's overrides now reach live sessions too, exactly as
      // the workflow runner already spreads them into scheduled games.
      ...optionalField('step_timeout_ms', overrides?.step_timeout_ms),
      ...optionalField('episode_timeout_ms', overrides?.episode_timeout_ms),
    }
  }

  /**
   * Batch the display names for the recording header (the human owner and every submission owner) at
   * launch. A missing directory, or a lookup that throws, degrades to no names: the header labels then
   * fall back to the stable ids rather than failing a launch whose session row is already inserted.
   */
  private async snapshotNames(
    ownerUserId: string,
    resolvedSeats: ResolvedSeat[],
  ): Promise<Map<string, string>> {
    if (this.userDirectory === undefined) {
      return new Map()
    }
    const ids = [
      ownerUserId,
      ...resolvedSeats.flatMap((seat) =>
        seat.kind === 'submission'
          ? [seat.submission.user_id]
          : seat.kind === 'human' && seat.companion?.kind === 'submission'
            ? [seat.companion.submission.user_id]
            : [],
      ),
    ]
    try {
      return await this.userDirectory.namesFor(ids)
    } catch (error) {
      this.log(
        `orchestrator: resolving display names failed, falling back to ids: ${String(error)}`,
      )
      return new Map()
    }
  }
}

/**
 * Resolve the effective messaging rules for a session: enabled is the environment metadata AND the
 * season override (default when the override omits it), and the cap is the minimum of the metadata
 * cap and the override cap, so an override can only disable or tighten, never enable an opted-out
 * environment or loosen its cap.
 */
function resolveMessaging(
  meta: EnvironmentMeta,
  override: { enabled?: boolean; message_cap?: number } | undefined,
): { enabled: boolean; cap: number | null } {
  const enabled = meta.messaging && (override?.enabled ?? true)
  const caps = [meta.message_cap, override?.message_cap].filter(
    (cap): cap is number => cap !== null && cap !== undefined,
  )
  return { enabled, cap: caps.length > 0 ? Math.min(...caps) : null }
}
