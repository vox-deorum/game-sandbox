/**
 * A programmable {@link ExecutionDriver} test double.
 *
 * The orchestrator, relay, and HTTP suites (build-order step 5) run against this instead of a
 * real container: a test launches a session, then drives the returned {@link FakeSessionProcess}
 * by hand — emit protocol lines outward, inspect the lines the backend sent inward, finish the
 * process with a chosen {@link ExitInfo}, and observe `kill`. No Docker, no Python, deterministic.
 *
 * This lives under `test/` on purpose: it is not production code and must never be imported by
 * `src/`. It depends only on the type-only `driver/index.ts`, so it stays in lockstep with the
 * real driver's contract.
 */
import type {
  ExecutionDriver,
  ExitInfo,
  ImageRef,
  ImageSpec,
  LaunchSpec,
  OverlayImage,
  SessionProcess,
} from '../../src/driver/index.js'

/**
 * A push-based {@link AsyncIterable}: producers call {@link push} to enqueue values and
 * {@link close} to end the stream; a single consumer drives it with `for await`. Backs the
 * `output` and `diagnostics` channels, each consumed once by the relay.
 */
class AsyncChannel<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = []
  private readonly waiting: ((result: IteratorResult<T>) => void)[] = []
  private closed = false

  push(value: T): void {
    if (this.closed) {
      return
    }
    const wake = this.waiting.shift()
    if (wake) {
      wake({ value, done: false })
    } else {
      this.buffer.push(value)
    }
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    for (const wake of this.waiting.splice(0)) {
      wake({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift() as T, done: false })
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true })
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiting.push(resolve)
        })
      },
    }
  }
}

/** The exit a bare `kill()` produces when the test has not already finished the process. */
const KILLED_EXIT: ExitInfo = { code: 137, oomKilled: false }

/**
 * One launched fake session. The {@link SessionProcess} members behave for real (the channels
 * iterate, `exited` resolves, `send` records); the `emit*`/`finish`/`oom` methods and the `sent`
 * and `killGraceMs` fields are the test-facing controls.
 */
export class FakeSessionProcess implements SessionProcess {
  /** Lines the backend sent inward via {@link send}, in order. */
  readonly sent: string[] = []
  /** The `graceMs` of every {@link kill} call, in order — empty if the process was never killed. */
  readonly killGraceMs: number[] = []

  private readonly out = new AsyncChannel<string>()
  private readonly diag = new AsyncChannel<string>()
  private resolveExit!: (info: ExitInfo) => void
  private finished = false

  readonly exited: Promise<ExitInfo> = new Promise<ExitInfo>((resolve) => {
    this.resolveExit = resolve
  })

  get output(): AsyncIterable<string> {
    return this.out
  }

  get diagnostics(): AsyncIterable<string> {
    return this.diag
  }

  send(line: string): void {
    this.sent.push(line)
  }

  async kill(graceMs: number): Promise<void> {
    this.killGraceMs.push(graceMs)
    this.finish(KILLED_EXIT)
  }

  // --- test controls ---

  /** Push one protocol line out of the session. Ignored once finished. */
  emit(line: string): void {
    this.out.push(line)
  }

  /** Push one diagnostic (log) line out of the session. Ignored once finished. */
  emitDiagnostic(line: string): void {
    this.diag.push(line)
  }

  /** Whether {@link finish} has been called (directly, via {@link oom}, or via {@link kill}). */
  get isFinished(): boolean {
    return this.finished
  }

  /**
   * End the session: close both channels (so consumers' `for await` loops complete) and resolve
   * {@link exited}. Idempotent — the first call wins, later calls are no-ops, so a test's explicit
   * `finish` and a racing `kill` do not double-resolve.
   */
  finish(info: ExitInfo): void {
    if (this.finished) {
      return
    }
    this.finished = true
    this.out.close()
    this.diag.close()
    this.resolveExit(info)
  }

  /** Finish as an out-of-memory kill — the orchestrator's `oom_killed` path. */
  oom(code = 137): void {
    this.finish({ code, oomKilled: true })
  }
}

/** One recorded {@link ExecutionDriver.launch} call: the spec it was given and the process returned. */
export interface FakeLaunch {
  spec: LaunchSpec
  process: FakeSessionProcess
}

/**
 * A fake {@link ExecutionDriver}. Records every `ensureImage` and `launch`, returns a fresh
 * {@link FakeSessionProcess} per launch, and exposes hooks for tests that need to react the moment
 * a launch happens.
 */
export class FakeDriver implements ExecutionDriver {
  /** Every {@link ensureImage} spec, in order. */
  readonly imageRequests: ImageSpec[] = []
  /** Every {@link launch}, in order. */
  readonly launches: FakeLaunch[] = []

  /** Called synchronously inside {@link launch}, before it returns — drive the process from here. */
  onLaunch?: (launch: FakeLaunch) => void

  /** Overlay images the fake "manages", keyed by ref; tests seed and inspect this directly. */
  readonly overlayImages = new Map<string, OverlayImage>()
  /** Every {@link removeImage} ref, in order. */
  readonly removedImages: string[] = []
  /** Every {@link releaseSessionOverlay} session-overlay ref, in order (non-session refs no-op). */
  readonly releasedSessionOverlays: string[] = []

  ensureImage(spec: ImageSpec): Promise<ImageRef> {
    this.imageRequests.push(spec)
    const suffix = spec.kind === 'submission-overlay' ? `:${spec.submissionId}` : ''
    return Promise.resolve({ ref: `fake-image:${spec.kind}:deps-v${spec.depsVersion}${suffix}` })
  }

  listOverlayImages(): Promise<OverlayImage[]> {
    return Promise.resolve([...this.overlayImages.values()])
  }

  removeImage(ref: string): Promise<void> {
    this.removedImages.push(ref)
    this.overlayImages.delete(ref)
    return Promise.resolve()
  }

  /**
   * Release a composed session-overlay ref once its session ends. Mirrors the real driver's
   * no-op contract: only a ref that names a session-overlay image is recorded and removed.
   */
  releaseSessionOverlay(ref: string): Promise<void> {
    if (!ref.includes('session-overlay')) {
      return Promise.resolve()
    }
    this.releasedSessionOverlays.push(ref)
    this.overlayImages.delete(ref)
    return Promise.resolve()
  }

  launch(spec: LaunchSpec): Promise<SessionProcess> {
    const launch: FakeLaunch = { spec, process: new FakeSessionProcess() }
    this.launches.push(launch)
    this.onLaunch?.(launch)
    return Promise.resolve(launch.process)
  }

  /** The most recent launch, or `undefined` if none yet. */
  lastLaunch(): FakeLaunch | undefined {
    return this.launches.at(-1)
  }
}
