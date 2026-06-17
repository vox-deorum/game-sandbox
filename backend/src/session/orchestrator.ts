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
import { decodeIterationConfig, type Storage } from '../storage/index.js'
import type { Session, SessionMode } from '../storage/schema.js'
import type { SubmissionSource } from '../submission/source/index.js'
import { ensureSubmissionImage, submissionSlotPath } from '../submission/submission-image.js'
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
/** The single Flappy Bird agent slot a submitted-agent watch run fills; lockstep with the harness. */
const SUBMISSION_SLOT_ID = 'player_0'

/** A start request, already attributed to a user by the HTTP layer's identity resolution. */
export interface StartRequest {
  userId: string
  envId: string
  mode: SessionMode
  seed?: number
  humanSlotTimeoutMs?: number
  /**
   * When present, this is a submitted-agent watch run: the named submission's code fills the agent
   * slot and the session launches from its overlay image. `submissionId` selects whose code runs, not
   * who started the session. The run is still attributed to {@link StartRequest.userId}.
   */
  submissionId?: string
}

/** Which submission fills which slot from which container path, threaded into the session config. */
interface SubmissionBinding {
  submissionId: string
  slotId: string
  path: string
  /** The submission owner, attributed to the slot in the recording header. */
  userId: string
}

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
     * The submission-source seam, needed only to rebuild a submission's overlay when the cached image
     * was evicted (the helper refetches the pinned tree). Optional: a deployment or test that never
     * runs a submitted-agent watch session can omit it, and a `submissionId` run then fails cleanly.
     */
    private readonly submissionSource?: SubmissionSource,
  ) {}

  /**
   * Start a session: enforce one per user, validate the environment and mode, resolve the seed and
   * human-slot timeout, ensure the image, insert the `starting` row, and launch the container.
   */
  async start(request: StartRequest): Promise<StartResult> {
    // Validate the request first (a malformed start is a 400 regardless of identity), then the
    // allowlist (403), then the one-per-user rule (409).
    const meta = this.environments.get(request.envId)
    if (meta === undefined) {
      throw new OrchestratorError(400, `unknown environment ${request.envId}`)
    }
    if (request.mode !== 'human' && request.mode !== 'scripted') {
      throw new OrchestratorError(400, `invalid mode ${String(request.mode)}`)
    }
    if (request.mode === 'human' && meta.human_slots.length === 0) {
      throw new OrchestratorError(
        400,
        `environment ${request.envId} has no human-controllable slot`,
      )
    }
    // A submitted agent fills the (single) agent slot, so its run is a non-human watch session; a
    // human-mode submission run would contend for the same slot. Reject it as a malformed request.
    if (request.submissionId !== undefined && request.mode !== 'scripted') {
      throw new OrchestratorError(400, 'a submitted-agent run must be a scripted watch session')
    }
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

    const humanTimeoutMs =
      request.humanSlotTimeoutMs !== undefined ? request.humanSlotTimeoutMs : meta.human_timeout_ms
    const seed = request.seed ?? randomInt(0, 2 ** 31)

    // For a submitted-agent run the image is the submission's overlay and the agent slot binds its
    // path; otherwise it is the built-in scripted/human path on the base image, exactly as before.
    const { image, submissionBinding } = await this.resolveImage(request, meta)

    const id = randomUUID()
    const recordingId = `${meta.env_id}-${id}`
    const createdAt = new Date().toISOString()
    await this.storage.createSession({
      id,
      user_id: request.userId,
      env_id: meta.env_id,
      mode: request.mode,
      recording_id: recordingId,
      created_at: createdAt,
    })
    if (submissionBinding !== null) {
      // Tie the session to the submission so the agent profile can list it as a recent run.
      await this.storage.recordSessionSubmission(
        id,
        submissionBinding.submissionId,
        submissionBinding.slotId,
      )
    }

    const sandbox = this.sandboxProfile()
    const sessionConfig = this.sessionConfig(
      meta,
      request.mode,
      seed,
      humanTimeoutMs,
      recordingId,
      submissionBinding,
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
      mode: request.mode,
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
   * Resolve the image to launch. A plain run ensures the session base image, as before. A
   * `submissionId` run resolves the submission (it must be `ready` and for the requested
   * environment's open iteration), ensures its overlay image through the submission-image helper, and
   * returns the slot binding the session config threads into `player_0`.
   */
  private async resolveImage(
    request: StartRequest,
    meta: EnvironmentMeta,
  ): Promise<{ image: ImageRef; submissionBinding: SubmissionBinding | null }> {
    if (request.submissionId === undefined) {
      return {
        image: await this.driver.ensureImage(currentSessionBaseImageSpec()),
        submissionBinding: null,
      }
    }
    if (this.submissionSource === undefined) {
      throw new OrchestratorError(500, 'submitted-agent runs are not configured on this deployment')
    }
    const submission = await this.storage.getSubmission(request.submissionId)
    if (submission === undefined) {
      throw new OrchestratorError(404, 'no such submission')
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
    // Only the open iteration's active submissions are watch choices; a superseded (resubmitted-over)
    // or closed-iteration submission stays profile history rather than a runnable agent.
    const iteration = await this.storage.getOpenSubmissionIteration(meta.env_id)
    if (
      iteration === undefined ||
      submission.iteration_id !== iteration.id ||
      submission.superseded_at !== null
    ) {
      throw new OrchestratorError(
        409,
        'submission is not the active submission for the open iteration',
        'submission_not_active',
      )
    }
    const image = await ensureSubmissionImage(
      {
        driver: this.driver,
        source: this.submissionSource,
        imagePolicy: this.config.docker.imagePolicy,
      },
      submission,
      decodeIterationConfig(iteration.config).deps_version,
      SUBMISSION_SLOT_ID,
    )
    return {
      image,
      submissionBinding: {
        submissionId: submission.id,
        slotId: SUBMISSION_SLOT_ID,
        path: submissionSlotPath(SUBMISSION_SLOT_ID),
        userId: submission.user_id,
      },
    }
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
   * Build the session config the container reads from argv. Human slots are driven by the transport
   * in human mode and by the built-in agent otherwise; any non-human slot always runs the built-in
   * agent. For a submitted-agent run, the bound slot is still a `builtin-agent` but carries the
   * overlay path the harness loads its code from. Environment facts (pace, limits, the default human
   * timeout) live in the in-image registry, so only the overrides travel here.
   */
  private sessionConfig(
    meta: EnvironmentMeta,
    mode: SessionMode,
    seed: number,
    humanTimeoutMs: number | null,
    recordingId: string,
    submissionBinding: SubmissionBinding | null,
    ownerLogin: string,
  ): Record<string, unknown> {
    const slotIds = new Set<string>(meta.human_slots)
    for (let i = 0; i < meta.max_slots; i++) {
      slotIds.add(`player_${i}`)
    }
    const humanSlots = new Set(meta.human_slots)
    // Decide what fills each slot — the submitted agent, a connected human, or the Naive baseline —
    // then hand the assignment to the shared seam that produces the `slots`/`players` wire blocks the
    // headless workflow runner builds the same way.
    const seats = new Map<string, SeatBinding>()
    for (const slotId of slotIds) {
      if (submissionBinding !== null && slotId === submissionBinding.slotId) {
        seats.set(slotId, {
          driver: 'submission',
          submissionId: submissionBinding.submissionId,
          userId: submissionBinding.userId,
          path: submissionBinding.path,
        })
        continue
      }
      if (mode === 'human' && humanSlots.has(slotId)) {
        seats.set(slotId, { driver: 'human', login: ownerLogin })
      } else {
        seats.set(slotId, { driver: 'naive' })
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
