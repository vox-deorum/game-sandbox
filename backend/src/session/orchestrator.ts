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
import type { ExecutionDriver, SandboxProfile } from '../driver/index.js'
import type { EnvironmentMeta, EnvironmentRegistry } from '../environments.js'
import type { Storage } from '../storage/index.js'
import type { Session, SessionMode } from '../storage/schema.js'
import {
  type Attachment,
  type ClientSocket,
  ensureRecordingsDir,
  LiveSession,
} from './live-session.js'
import { SessionRegistry } from './registry.js'

/** The dependency-set version this stage builds; Stage 5 resolves it per submission. */
const DEPS_VERSION = 1
/** Where the recordings volume is mounted inside every session container. */
const CONTAINER_RECORDINGS_DIR = '/recordings'
/** The writable scratch tmpfs mount point; matplotlib's cache and any temp files land here. */
const CONTAINER_SCRATCH_DIR = '/tmp'
/** Grace given to a container to end politely before the driver hard-kills it. */
const KILL_GRACE_MS = 5_000

/** A start request, already attributed to a user by the HTTP layer's identity resolution. */
export interface StartRequest {
  userId: string
  envId: string
  mode: SessionMode
  seed?: number
  humanSlotTimeoutMs?: number
}

/** What the HTTP layer returns to a client that started a session. */
export interface StartResult {
  id: string
  wsPath: string
}

/** A start/stop failure carrying the HTTP status the route should map it to. */
export class OrchestratorError extends Error {
  constructor(
    readonly status: number,
    message: string,
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
  ) {}

  /**
   * Start a session: enforce one per user, validate the environment and mode, resolve the seed and
   * human-slot timeout, ensure the image, insert the `starting` row, and launch the container.
   */
  async start(request: StartRequest): Promise<StartResult> {
    if (this.registry.hasActiveUser(request.userId)) {
      throw new OrchestratorError(409, 'user already has an active session')
    }
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

    const humanTimeoutMs =
      request.humanSlotTimeoutMs !== undefined ? request.humanSlotTimeoutMs : meta.human_timeout_ms
    const seed = request.seed ?? randomInt(0, 2 ** 31)

    const image = await this.driver.ensureImage({ kind: 'session-base', depsVersion: DEPS_VERSION })

    const id = randomUUID()
    const recordingId = `${meta.env_id}-${id}`
    await this.storage.createSession({
      id,
      user_id: request.userId,
      env_id: meta.env_id,
      mode: request.mode,
      recording_id: recordingId,
      created_at: new Date().toISOString(),
    })

    const sandbox = this.sandboxProfile()
    const sessionConfig = this.sessionConfig(meta, request.mode, seed, humanTimeoutMs, recordingId)
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
      process,
      humanSlots: meta.human_slots,
      deps: {
        storage: this.storage,
        onEnd: (endedId) => this.registry.remove(endedId),
        log: this.log,
        idleTimeoutMs: this.config.sessionIdleTimeoutMs,
        maxDurationMs: this.config.sessionMaxDurationMs,
        killGraceMs: KILL_GRACE_MS,
      },
    })
    this.registry.add(session)

    return { id, wsPath: `/api/sessions/${id}/ws` }
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
   * agent. Environment facts (pace, limits, the default human timeout) live in the in-image
   * registry, so only the overrides travel here.
   */
  private sessionConfig(
    meta: EnvironmentMeta,
    mode: SessionMode,
    seed: number,
    humanTimeoutMs: number | null,
    recordingId: string,
  ): Record<string, unknown> {
    const slotIds = new Set<string>(meta.human_slots)
    for (let i = 0; i < meta.max_slots; i++) {
      slotIds.add(`player_${i}`)
    }
    const humanSlots = new Set(meta.human_slots)
    const slots: Record<string, { kind: string }> = {}
    for (const slotId of slotIds) {
      const external = mode === 'human' && humanSlots.has(slotId)
      slots[slotId] = { kind: external ? 'external' : 'builtin-agent' }
    }
    return {
      env_id: meta.env_id,
      seed,
      slots,
      human_timeout_ms: humanTimeoutMs,
      recording_dir: CONTAINER_RECORDINGS_DIR,
      recording_id: recordingId,
    }
  }
}
