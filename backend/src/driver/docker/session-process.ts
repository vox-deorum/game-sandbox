/**
 * {@link SessionProcess} over a Docker container's attached stdio.
 *
 * The bidirectional line channel the driver interface promises is carried here over a single
 * hijacked attach stream: Docker multiplexes the container's stdout and stderr onto it, the modem
 * demultiplexes them back apart, stdout becomes {@link output} and stderr {@link diagnostics}, and
 * {@link send} writes a line back onto the same stream's stdin. Nothing above the driver may assume
 * any of this — a Kubernetes driver satisfies the same interface over attach, exec, or a sidecar.
 *
 * Lifecycle: attach *before* start so no early output is missed, then start, then `wait()` for the
 * exit code and `inspect()` for the driver-neutral OOM flag (the container is created without
 * auto-remove precisely so that inspect still works). LLM-network cleanup is held after exit until
 * the lifecycle owner calls {@link kill}, giving it a safe point to revoke and drain proxy work.
 * `onRemoved` (a GPU lease release) runs once the container is gone, without changing that timing.
 */
import type { PassThrough } from 'node:stream'
import { PassThrough as PassThroughStream } from 'node:stream'

import type { Container } from 'dockerode'

import { appLog } from '../../logging/log-buffer.js'
import { AsyncChannel } from '../../util/async-channel.js'
import type { ExitInfo, SessionProcess } from '../index.js'
import { pumpLines } from './lines.js'

export class DockerSessionProcess implements SessionProcess {
  readonly output: AsyncIterable<string>
  readonly diagnostics: AsyncIterable<string>
  readonly exited: Promise<ExitInfo>

  private readonly stdin: NodeJS.WritableStream
  private readonly container: Container
  /** Ordinary containers are removed on exit; LLM containers wait for their owner's kill. */
  private readonly removesOnExit: boolean
  private readonly remove: () => Promise<void>
  private readonly settleExit: (info: ExitInfo) => void
  /** Set once `wait()` reports exit, so a later kill knows the container no longer runs. */
  private exitObserved = false

  private constructor(
    container: Container,
    stdio: NodeJS.ReadWriteStream,
    removesOnExit: boolean,
    remove: () => Promise<void>,
  ) {
    this.container = container
    this.stdin = stdio
    this.removesOnExit = removesOnExit
    this.remove = remove

    const outChannel = new AsyncChannel<string>()
    const diagChannel = new AsyncChannel<string>()
    this.output = outChannel
    this.diagnostics = diagChannel

    const stdout: PassThrough = new PassThroughStream()
    const stderr: PassThrough = new PassThroughStream()
    pumpLines(stdout, outChannel)
    pumpLines(stderr, diagChannel)
    container.modem.demuxStream(stdio, stdout, stderr)
    // demuxStream never ends its targets; end them when the carrier ends so the line channels close.
    stdio.on('end', () => {
      stdout.end()
      stderr.end()
    })
    stdio.on('error', () => {
      stdout.end()
      stderr.end()
    })

    let settle!: (info: ExitInfo) => void
    this.exited = new Promise<ExitInfo>((resolve) => {
      settle = resolve
    })
    this.settleExit = settle
  }

  /**
   * Create the container's stdio attachment, start it, and wire up the channels. Attaches before
   * starting so the very first protocol line (the recording header) is never lost, and only waits
   * for the exit *after* the start — `wait()` on a not-yet-started container returns immediately.
   */
  static async start(
    container: Container,
    cleanup?: () => Promise<void>,
    onRemoved?: () => void,
  ): Promise<DockerSessionProcess> {
    const remove = containerRemoval(container, cleanup, onRemoved)
    let stdio: NodeJS.ReadWriteStream
    try {
      // docker-modem 5.x carries a hijacked attach by JSON-serializing these options as the POST
      // body and writing them onto the upgraded socket — which is also the only thing that flushes
      // the request, so the body cannot simply be suppressed. Those bytes arrive at the head of the
      // container's stdin; the harness command pump tolerates the preamble (see live_io.handle_line).
      stdio = (await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
        hijack: true,
      })) as unknown as NodeJS.ReadWriteStream
    } catch (error) {
      // Attach failed before any process wrapped the container; the container was already created by
      // the driver, so remove it directly or it leaks (nothing upstream holds a handle to clean up).
      await remove().catch((cause) => logRemovalFailure(container, cause))
      throw error
    }
    const process = new DockerSessionProcess(container, stdio, cleanup === undefined, remove)
    try {
      await container.start()
    } catch (error) {
      // The container exists and is attached but never started; remove it (and tear the channels
      // down) so a failed launch leaves nothing behind for the next reap to find.
      await process.remove().catch((cause) => logRemovalFailure(container, cause))
      throw error
    }
    container.wait().then(
      (result: { StatusCode: number }) => process.onExit(result.StatusCode),
      () => process.onWaitError(),
    )
    return process
  }

  private async onExit(statusCode: number): Promise<void> {
    this.exitObserved = true
    const info = await this.resolveExit(statusCode)
    // Ordinary containers keep the historical eager removal. LLM containers retain their relay and
    // networks until their owner observes exit, revokes admission, drains requests, and calls kill.
    if (this.removesOnExit) {
      await this.remove().catch((cause) => logRemovalFailure(this.container, cause))
    }
    this.settleExit(info)
  }

  /** A broken wait stream is still terminal; an LLM lifecycle owner performs ordered teardown. */
  private async onWaitError(): Promise<void> {
    if (this.removesOnExit) {
      await this.remove().catch((cause) => logRemovalFailure(this.container, cause))
    }
    this.settleExit({ code: -1, oomKilled: false })
  }

  send(line: string): void {
    try {
      this.stdin.write(line.endsWith('\n') ? line : `${line}\n`)
    } catch {
      // The session has exited and the stdin pipe is gone; a late command is simply dropped.
    }
  }

  async kill(graceMs: number): Promise<void> {
    let stopped = this.exitObserved
    try {
      // Docker stop sends SIGTERM, waits `t` seconds, then SIGKILL. Round up so a sub-second
      // grace still gives the container a whole second to stop politely.
      await this.container.stop({ t: Math.max(0, Math.ceil(graceMs / 1000)) })
      stopped = true
    } catch (error) {
      // 304 means already stopped. Any other error, such as a daemon failure, leaves the container
      // possibly running, so only the forced removal below can confirm teardown.
      if (statusCode(error) === 304) stopped = true
    }
    try {
      await this.remove()
    } catch (error) {
      // A stopped container never runs again, so its owner may move on. Removal keeps retrying in
      // the background and holds the GPU lease until Docker confirms it.
      if (!stopped) throw error
      logRemovalFailure(this.container, error)
    }
  }

  private async resolveExit(statusCode: number): Promise<ExitInfo> {
    let oomKilled = false
    let code = statusCode
    try {
      const info = await this.container.inspect()
      // Some Docker/cgroup combinations surface a hard memory kill only as SIGKILL's conventional
      // exit code. Treat that as OOM when Docker does not set the explicit flag, so callers keep a
      // stable driver-neutral signal across runtimes.
      oomKilled = (info.State?.OOMKilled ?? false) || statusCode === 137
      if (typeof info.State?.ExitCode === 'number') {
        code = info.State.ExitCode
      }
    } catch {
      // The container was already removed (a racing kill); keep the wait() status code.
    }
    return { code, oomKilled }
  }
}

/** Keep retrying failed removal even when a failed launch or cancelled run drops its process. */
function containerRemoval(
  container: Container,
  cleanup?: () => Promise<void>,
  onRemoved?: () => void,
): () => Promise<void> {
  let removal: Promise<void> | null = null
  let retry: NodeJS.Timeout | undefined
  const remove = (): Promise<void> => {
    if (removal === null) {
      clearTimeout(retry)
      retry = undefined
      removal = removeContainer(container)
        .then(() => onRemoved?.())
        .then(() => cleanup?.().catch(() => undefined))
        .catch((error) => {
          removal = null
          retry = setTimeout(() => {
            void remove().catch((cause) => logRemovalFailure(container, cause))
          }, 5_000)
          retry.unref()
          throw error
        })
    }
    return removal
  }
  return remove
}

/** Docker's 404 confirms that a racing teardown already removed the container. */
async function removeContainer(container: Container): Promise<void> {
  try {
    await container.remove({ force: true })
  } catch (error) {
    if (statusCode(error) !== 404) throw error
  }
}

function statusCode(error: unknown): number | undefined {
  return (error as { statusCode?: number } | null)?.statusCode
}

function logRemovalFailure(container: Container, error: unknown): void {
  appLog('session', `container ${container.id}: removal failed: ${String(error)}`, 'error')
}
