/**
 * The sandboxed load check (Stage 5.4): run the harness `validate` command against a built overlay
 * image and turn its structured result into a typed accept or rejection.
 *
 * This is the dynamic half of validation — it confirms the agent *loads* (imports, constructs,
 * exposes `reset`/`act`) without ever constructing or stepping the environment. It launches the
 * overlay under the same locked-down sandbox profile real sessions use (the caller passes it: no
 * network, read-only root, fixed quotas), reads the single `validate-result` envelope the command
 * emits on stdout, and bounds the whole thing with a short timeout since import-and-construct should
 * be near-instant and a hang is itself a failure. The container is always torn down — on a clean
 * exit by the driver, on a timeout by an explicit kill.
 *
 * It is driver-neutral: it depends only on the type-only driver seam and an injected launcher, so the
 * same function runs against the real Docker driver in the pipeline and a fake in tests. The worker
 * (step 5) is what records the `load` stage of the validation log from this result.
 */
import type { ImageRef, LaunchSpec, SandboxProfile, SessionProcess } from '../../driver/index.js'
import { CANONICAL_SUBMISSION_SEAT, SUBMISSION_SEAT_BASE } from '../submission-image.js'

/** The `validate` command, run as the container entrypoint in place of the live runner. */
const VALIDATE_ENTRYPOINT = ['python', '-m', 'game_sandbox_harness.validate']
/** The outbound envelope kind the command emits (lockstep with `validate.py`'s `RESULT_KIND`). */
const RESULT_KIND = 'validate-result'
/** Grace before a timed-out load check is hard-killed. */
const KILL_GRACE_MS = 2_000

/** The minimal launch capability this module needs, so a fake launcher satisfies it in tests. */
export interface Launcher {
  launch(spec: LaunchSpec): Promise<SessionProcess>
}

/** A successful load: the agent imported, constructed, and exposes the required hooks. */
export interface LoadCheckSuccess {
  ok: true
}

/**
 * A failed load. `code` is the harness's structured code (`import_error`, `class_not_found`,
 * `constructor_error`, `missing_hook`) when the command reported one, or `timeout` / `no_result`
 * when the container hung or exited without a parseable result. `detail` is the owner-visible
 * message the worker records as the `load` stage's detail.
 */
export interface LoadCheckFailure {
  ok: false
  code: string
  detail: string
}

export type LoadCheckResult = LoadCheckSuccess | LoadCheckFailure

/** Options for one load-check run. */
export interface LoadCheckOptions {
  /** The locked-down profile the overlay runs under — the same one real sessions use. */
  sandbox: SandboxProfile
  /** A label for the launched container (the submission id makes a good one). */
  sessionId: string
  /** Wall-clock ceiling; a load check that does not finish in time fails as `timeout`. */
  timeoutMs: number
  /** The seat whose repo root is validated; defaults to the canonical singleton `seat_0`. */
  seatId?: string
}

/** The shape of the `validate` command's result envelope. */
interface ValidateEnvelope {
  kind: string
  ok: boolean
  code?: string
  detail?: string
}

function parseEnvelope(line: string): ValidateEnvelope | null {
  const text = line.trim()
  if (!text.startsWith('{')) {
    return null
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { kind?: unknown }).kind === RESULT_KIND
    ) {
      return parsed as ValidateEnvelope
    }
  } catch {
    // A non-JSON or partial line on stdout is not the envelope; keep scanning.
  }
  return null
}

/** Drain a channel to completion so a container is never blocked on an unread pipe. */
async function drain(channel: AsyncIterable<string>): Promise<void> {
  for await (const _ of channel) {
    // discard
  }
}

const TIMEOUT = Symbol('load-check-timeout')

function timeoutFailure(timeoutMs: number): LoadCheckFailure {
  return {
    ok: false,
    code: 'timeout',
    detail: `load check did not finish within ${timeoutMs}ms`,
  }
}

/**
 * Run the load check against `image` and return its typed result. Launches the overlay running the
 * `validate` command, captures the first `validate-result` envelope from stdout, and races the
 * container's exit against `timeoutMs`.
 */
export async function runLoadCheck(
  launcher: Launcher,
  image: ImageRef,
  options: LoadCheckOptions,
): Promise<LoadCheckResult> {
  const seatId = options.seatId ?? CANONICAL_SUBMISSION_SEAT
  const repoRoot = `${SUBMISSION_SEAT_BASE}/${seatId}`

  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      resolve(TIMEOUT)
    }, options.timeoutMs)
    timer.unref?.()
  })

  const launchAttempt = launcher
    .launch({
      image,
      entrypoint: VALIDATE_ENTRYPOINT,
      argv: [repoRoot],
      sandbox: options.sandbox,
      sessionId: options.sessionId,
    })
    .then(async (process) => {
      if (timedOut) {
        await process.kill(KILL_GRACE_MS)
      }
      return process
    })

  let proc: SessionProcess
  try {
    const launched = await Promise.race([launchAttempt, timeout])
    if (launched === TIMEOUT) {
      // The launch may still complete after our caller has moved on; kill that late process if it
      // appears, and swallow the racing launch's eventual resolution or rejection.
      launchAttempt.catch(() => undefined)
      return timeoutFailure(options.timeoutMs)
    }
    proc = launched
  } catch (error) {
    clearTimeout(timer)
    throw error
  }

  // Diagnostics (stderr) are not the protocol; drain them so the pipe never blocks the container.
  void drain(proc.diagnostics)

  // A holder (not a bare `let`) so reading it back after the await keeps its declared type — TS does
  // not narrow a closure-mutated local, and would otherwise see it as forever-null here.
  const captured: { envelope: ValidateEnvelope | null } = { envelope: null }
  const collect = (async () => {
    for await (const line of proc.output) {
      const parsed = parseEnvelope(line)
      if (parsed !== null) {
        captured.envelope = parsed
        // Keep draining the rest of stdout so the writer never blocks; just stop capturing.
      }
    }
  })()

  const outcome = await Promise.race([proc.exited, timeout])
  if (outcome === TIMEOUT) {
    await proc.kill(KILL_GRACE_MS)
    // The kill closes stdout, so the collector loop ends; await it (swallowing any iteration error
    // on the torn-down stream) so it never outlives this call as an unhandled rejection.
    await collect.catch(() => undefined)
    return timeoutFailure(options.timeoutMs)
  }
  clearTimeout(timer)

  // The container has exited, so stdout has closed; finish collecting its envelope.
  await collect
  const envelope = captured.envelope

  if (envelope === null) {
    return {
      ok: false,
      code: 'no_result',
      detail: `load check exited (code ${outcome.code}) without emitting a result`,
    }
  }
  if (envelope.ok) {
    return { ok: true }
  }
  return {
    ok: false,
    code: envelope.code ?? 'load_failed',
    detail: envelope.detail ?? 'the agent failed to load',
  }
}
