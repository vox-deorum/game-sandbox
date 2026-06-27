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

import type { Config } from '../config.js'
import { currentSessionBaseImageSpec } from '../deps-version.js'
import type { ExecutionDriver, ImageRef, SandboxProfile } from '../driver/index.js'
import type { EnvironmentMeta, EnvironmentRegistry } from '../environments.js'
import { isAllowlisted } from '../identity.js'
import { decodeSeasonConfig, type Storage, type Submission } from '../storage/index.js'
import type { Season, Session, SessionMode } from '../storage/schema.js'
import type { SubmissionSnapshotStore } from '../submission/snapshot-store.js'
import type { SubmissionSource } from '../submission/source/index.js'
import {
  ensureSessionImage,
  ensureSubmissionImage,
  type SessionImageSlot,
  submissionSlotPath,
} from '../submission/submission-image.js'
import { assembleSeats, type SeatBinding } from './launch-config.js'
import {
  type Attachment,
  type ClientSocket,
  ensureRecordingsDir,
  LiveSession,
} from './live-session.js'
import { SessionRegistry } from './registry.js'

/** Where the recordings volume is mounted inside every session container. */
const CONTAINER_RECORDINGS_DIR = '/recordings'
/** The writable scratch tmpfs mount point; matplotlib's cache and any temp files land here. */
const CONTAINER_SCRATCH_DIR = '/tmp'
/** Grace given to a container to end politely before the driver hard-kills it. */
const KILL_GRACE_MS = 5_000
/** This stage's single-human session-composition cap; later multi-human play relaxes it. */
const MAX_HUMAN_SLOTS = 1

/**
 * One slot's assignment in a start request: a connected human, the built-in Naive baseline, or a
 * named submitted agent. The discriminated union carries `submissionId` only on a `submission` slot,
 * so a human or built-in slot can never reference a submission and vice versa. The HTTP layer maps the
 * wire `slots` object (snake-case `submission_id`) onto this shape; its JSON schema enforces the id is
 * present exactly for a `submission` slot, so the orchestrator trusts the discriminant.
 */
export type SlotAssignment =
  | { kind: 'human' | 'builtin-agent' }
  | { kind: 'submission'; submissionId: string }

/**
 * A start request, already attributed to a user by the HTTP layer's identity resolution. The session
 * shape is an explicit per-slot `slots` assignment (Stage 7.4): every required seat names what fills
 * it, and the human-versus-scripted `mode` is derived from whether any slot is `human`, not sent.
 */
export interface StartRequest {
  userId: string
  envId: string
  seed?: number
  humanSlotTimeoutMs?: number
  /** Per-slot assignment keyed by slot id; must cover exactly the environment's required seats. */
  slots: Record<string, SlotAssignment>
}

/** Which submission fills which slot from which container path, threaded into the session config. */
interface SubmissionBinding {
  submissionId: string
  slotId: string
  path: string
  /** The submission owner, attributed to the slot in the recording header. */
  userId: string
}

/**
 * A slot after validation, keyed by id. A `submission` slot carries its loaded row; human and
 * built-in slots carry none. The discriminated union lets config assembly and image resolution read
 * the submission without a presence check.
 */
type ResolvedSlot =
  | { slotId: string; kind: 'human' | 'builtin-agent' }
  | { slotId: string; kind: 'submission'; submission: Submission }

/** What the HTTP layer returns to a client that started a session. */
export interface StartResult {
  id: string
  wsPath: string
}

/**
 * A start/stop failure carrying the HTTP status the route should map it to, an optional stable
 * machine code the frontend branches on (`not_allowlisted`, `already_active`), and optional details
 * merged into the error body (the active session id for the rejoin path).
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

export class Orchestrator {
  private readonly registry = new SessionRegistry()

  constructor(
    private readonly driver: ExecutionDriver,
    private readonly storage: Storage,
    private readonly environments: EnvironmentRegistry,
    private readonly config: Config,
    private readonly log: (message: string) => void = () => {},
    /**
     * Called after a session finalizes and its recording row is written, so retention can sweep the
     * just-grown data. Defaults to a no-op for tests that do not exercise retention; main wires it
     * to the retention sweep.
     */
    private readonly onSessionFinalized: (id: string) => void = () => {},
    /**
     * The submission-source seam, the fallback to refetch a pre-snapshot submission when rebuilding its
     * overlay. Optional: a deployment or test that never runs a submitted-agent watch session can omit
     * it (together with the snapshot store), and a `submissionId` run then fails cleanly.
     */
    private readonly submissionSource?: SubmissionSource,
    /**
     * The snapshot store an evicted overlay is rebuilt from. Paired with {@link submissionSource}:
     * both are present for a deployment that runs submitted agents, both omitted otherwise.
     */
    private readonly submissionSnapshots?: SubmissionSnapshotStore,
  ) {}

  /**
   * Start a session from an explicit per-slot `slots` assignment. Validate the shape authoritatively
   * (every required seat assigned, humans only in human-capable seats, at most one human this stage),
   * derive the human-versus-scripted `mode` from it, enforce one per user, resolve the seed and
   * human-slot timeout, ensure the image, insert the `starting` row, record one `session_submissions`
   * row per submitted slot, and launch the container. All validation runs before any container starts.
   */
  async start(request: StartRequest): Promise<StartResult> {
    // Validate the request first (a malformed start is a 400 regardless of identity), then the
    // allowlist (403), then the one-per-user rule (409).
    const meta = this.environments.get(request.envId)
    if (meta === undefined) {
      throw new OrchestratorError(400, `unknown environment ${request.envId}`)
    }
    const { assignments, mode } = this.validateSlotShape(meta, request.slots)

    // The allowlist gates starting a session in either mode, since a watch run also consumes a
    // container. Everything read-only (listing, fetching recordings, spectating) stays open.
    if (!isAllowlisted(request.userId, this.config.sessionAllowlist)) {
      throw new OrchestratorError(403, 'user is not on the session allowlist', 'not_allowlisted')
    }
    const activeId = this.registry.activeIdForUser(request.userId)
    if (activeId !== undefined) {
      throw new OrchestratorError(409, 'user already has an active session', 'already_active', {
        active_session_id: activeId,
      })
    }

    // Every session attaches to a play-open season — ratings hang off it, and each submitted slot must
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
    const resolvedSlots = await this.resolveSubmissions(assignments, meta, playSeason)

    const humanTimeoutMs =
      request.humanSlotTimeoutMs !== undefined ? request.humanSlotTimeoutMs : meta.human_timeout_ms
    const seed = request.seed ?? randomInt(0, 2 ** 31)

    // Resolve the launch image from the validated submitted slots: the base image when none, a single
    // submission's cached overlay, or a composed multi-submission session image.
    const { image, submissionBindings } = await this.resolveImage(resolvedSlots, playSeason)

    const id = randomUUID()
    const recordingId = `${meta.env_id}-${id}`
    const createdAt = new Date().toISOString()
    await this.storage.createSession({
      id,
      user_id: request.userId,
      env_id: meta.env_id,
      mode,
      recording_id: recordingId,
      season_id: playSeason.id,
      created_at: createdAt,
    })
    // One attribution row per submitted slot, so the agent profile can list each as a recent run.
    // Human and built-in slots are carried only in the recording header `players`, never here.
    for (const binding of submissionBindings) {
      await this.storage.recordSessionSubmission(id, binding.submissionId, binding.slotId)
    }

    const sandbox = this.sandboxProfile()
    const sessionConfig = this.sessionConfig(
      meta,
      seed,
      humanTimeoutMs,
      recordingId,
      resolvedSlots,
      request.userId,
    )
    await ensureRecordingsDir(this.recordingsHostDir())

    let process: Awaited<ReturnType<ExecutionDriver['launch']>>
    try {
      process = await this.driver.launch({
        image,
        argv: [JSON.stringify(sessionConfig)],
        sandbox,
        sessionId: id,
      })
    } catch (error) {
      // The row exists but no container does; mark it failed so it never looks active.
      await this.storage.markEnded(id, 'error', new Date().toISOString()).catch(() => undefined)
      throw new OrchestratorError(500, `failed to launch session: ${String(error)}`)
    }

    const session = new LiveSession({
      id,
      userId: request.userId,
      envId: meta.env_id,
      mode,
      recordingId,
      createdAt,
      process,
      humanSlots: meta.human_slots,
      deps: {
        storage: this.storage,
        onEnd: (endedId) => this.registry.remove(endedId),
        onFinalized: (endedId) => this.onSessionFinalized(endedId),
        log: this.log,
        idleTimeoutMs: this.config.sessionIdleTimeoutMs,
        maxDurationMs: this.config.sessionMaxDurationMs,
        killGraceMs: KILL_GRACE_MS,
      },
    })
    this.registry.add(session)

    return { id, wsPath: `/api/sessions/${id}/ws` }
  }

  /**
   * Authoritatively validate the `slots` assignment against the environment metadata and derive the
   * session mode. Rejects (400) a payload that does not assign exactly the environment's required seats
   * (`player_0…player_{max_slots-1}`), a human in a slot the metadata does not mark human-capable, and
   * more than this stage's single human slot. The `submission`-id discriminant is guaranteed by the
   * union and the wire schema, so it is not re-checked here. Returns the assignments ordered by slot
   * index and the derived mode (`human` when a human slot is present, else `scripted`).
   */
  private validateSlotShape(
    meta: EnvironmentMeta,
    slots: Record<string, SlotAssignment>,
  ): { assignments: { slotId: string; assignment: SlotAssignment }[]; mode: SessionMode } {
    const requiredIds: string[] = []
    for (let i = 0; i < meta.max_slots; i++) {
      requiredIds.push(`player_${i}`)
    }
    const required = new Set(requiredIds)
    for (const slotId of Object.keys(slots)) {
      if (!required.has(slotId)) {
        throw new OrchestratorError(400, `unknown slot ${slotId} for environment ${meta.env_id}`)
      }
    }

    const humanCapable = new Set(meta.human_slots)
    let humanCount = 0
    const assignments = requiredIds.map((slotId) => {
      const assignment = slots[slotId]
      if (assignment === undefined) {
        throw new OrchestratorError(400, `missing assignment for required slot ${slotId}`)
      }
      if (assignment.kind === 'human') {
        if (!humanCapable.has(slotId)) {
          throw new OrchestratorError(
            400,
            `slot ${slotId} is not human-controllable in environment ${meta.env_id}`,
          )
        }
        humanCount += 1
      }
      return { slotId, assignment }
    })
    if (humanCount > MAX_HUMAN_SLOTS) {
      throw new OrchestratorError(
        400,
        `at most ${MAX_HUMAN_SLOTS} human slot is allowed, got ${humanCount}`,
      )
    }
    return { assignments, mode: humanCount > 0 ? 'human' : 'scripted' }
  }

  /**
   * Load and validate the submission behind each `submission` slot (404 unknown, 400 wrong
   * environment, 409 not `ready`, 409 not active for the play-open season), leaving human and built-in
   * slots untouched. Returns the slots in assignment order with the loaded submission attached. The
   * checks mirror the Stage 5 single-submission watch path, applied per submitted slot.
   */
  private async resolveSubmissions(
    assignments: { slotId: string; assignment: SlotAssignment }[],
    meta: EnvironmentMeta,
    playSeason: Season,
  ): Promise<ResolvedSlot[]> {
    const resolved: ResolvedSlot[] = []
    for (const { slotId, assignment } of assignments) {
      if (assignment.kind !== 'submission') {
        resolved.push({ slotId, kind: assignment.kind })
        continue
      }
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
      resolved.push({ slotId, kind: 'submission', submission })
    }
    return resolved
  }

  /**
   * Resolve the launch image and the per-slot submission bindings from the already-validated slots.
   * With no submitted slot the base image runs, as before. A single submitted slot reuses the cached
   * per-submission overlay (the Stage 5 watch path), keeping its build-stage image warm. Two or more
   * submitted slots compose a multi-submission session image, each submission staged into its own
   * per-slot directory (the driver chains one single-slot overlay per slot). Every submitted slot
   * yields one binding regardless.
   */
  private async resolveImage(
    resolvedSlots: ResolvedSlot[],
    playSeason: Season,
  ): Promise<{ image: ImageRef; submissionBindings: SubmissionBinding[] }> {
    const composed: SessionImageSlot[] = []
    const submissionBindings: SubmissionBinding[] = []
    for (const slot of resolvedSlots) {
      if (slot.kind !== 'submission') {
        continue
      }
      composed.push({ slotId: slot.slotId, submission: slot.submission })
      submissionBindings.push({
        submissionId: slot.submission.id,
        slotId: slot.slotId,
        path: submissionSlotPath(slot.slotId),
        userId: slot.submission.user_id,
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
    // One submission reuses the cached per-submission overlay (the Stage 5 watch path, kept warm);
    // two or more compose a session image, each submission staged into its own per-slot directory.
    const [only] = composed
    const image =
      composed.length === 1 && only !== undefined
        ? await ensureSubmissionImage(imageDeps, only.submission, depsVersion, only.slotId)
        : await ensureSessionImage(imageDeps, composed, depsVersion)
    return { image, submissionBindings }
  }

  /** Attach a socket to a live session, or `undefined` if no such session is running. */
  attach(sessionId: string, socket: ClientSocket, userId: string): Attachment | undefined {
    const session = this.registry.get(sessionId)
    if (session === undefined) {
      return undefined
    }
    return session.attach(socket, session.userId === userId)
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

  private sandboxProfile(): SandboxProfile {
    return {
      cpus: this.config.sandbox.cpus,
      memoryMb: this.config.sandbox.memoryMb,
      readOnlyRoot: true,
      scratch: { containerPath: CONTAINER_SCRATCH_DIR, sizeMb: this.config.sandbox.scratchMb },
      network: 'none',
      mounts: [
        {
          hostPath: this.recordingsHostDir(),
          containerPath: CONTAINER_RECORDINGS_DIR,
          readOnly: false,
        },
      ],
    }
  }

  /**
   * Build the session config the container reads from argv from the validated slot assignments. Each
   * slot maps to its seat: a connected human (driven by the transport), the built-in Naive baseline,
   * or a submitted agent carrying the overlay path the harness loads its code from. The shared seam
   * produces the `slots`/`players` wire blocks the headless workflow runner builds the same way.
   * Environment facts (pace, limits, the default human timeout) live in the in-image registry, so only
   * the overrides travel here.
   */
  private sessionConfig(
    meta: EnvironmentMeta,
    seed: number,
    humanTimeoutMs: number | null,
    recordingId: string,
    resolvedSlots: ResolvedSlot[],
    ownerLogin: string,
  ): Record<string, unknown> {
    const seats = new Map<string, SeatBinding>()
    for (const slot of resolvedSlots) {
      if (slot.kind === 'human') {
        seats.set(slot.slotId, { driver: 'human', login: ownerLogin })
      } else if (slot.kind === 'submission') {
        seats.set(slot.slotId, {
          driver: 'submission',
          submissionId: slot.submission.id,
          userId: slot.submission.user_id,
          path: submissionSlotPath(slot.slotId),
        })
      } else {
        seats.set(slot.slotId, { driver: 'naive' })
      }
    }
    const { slots, players } = assembleSeats(seats)
    return {
      env_id: meta.env_id,
      seed,
      slots,
      human_timeout_ms: humanTimeoutMs,
      recording_dir: CONTAINER_RECORDINGS_DIR,
      recording_id: recordingId,
      players,
    }
  }
}
