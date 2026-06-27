/**
 * The local Docker execution driver: the first and, for now, only {@link ExecutionDriver}.
 *
 * It maps the driver-neutral {@link SandboxProfile} straight onto Docker's `HostConfig` and carries
 * the session's line channel over attached stdio (see {@link DockerSessionProcess}). This folder is
 * the one place `dockerode` may be imported — the Biome import-isolation rule enforces it — so a
 * Kubernetes driver lands as a sibling implementing the same interface with nothing above it
 * changing. Image caching lives here too, as the {@link DockerDriverOptions.imagePolicy}.
 */

import type { Container, ContainerCreateOptions } from 'dockerode'
import Docker from 'dockerode'

import type { DockerDriverOptions } from '../../config.js'
import type {
  ExecutionDriver,
  ImageRef,
  ImageSpec,
  LaunchSpec,
  OverlayImage,
  SessionBaseImageSpec,
  SessionProcess,
} from '../index.js'
import { ensureImage, imageTag } from './image.js'
import { ensureOverlayImage, listOverlayImages, removeImage } from './overlay.js'
import { DockerSessionProcess } from './session-process.js'

/** The label every session container carries, keyed by session id, for supervision and reaping. */
const SESSION_LABEL = 'game-sandbox.session'
/**
 * The OS process id of the backend that created the container. Reaping uses it to tell a true
 * orphan (a container whose creating process is gone — a crashed or previous backend) from a peer
 * backend's live container when several share one Docker daemon. Only the former is reaped.
 */
const OWNER_PID_LABEL = 'game-sandbox.owner-pid'

/** Whether a process with this id currently exists, so its containers are not orphans yet. */
function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 performs the existence/permission check without delivering a signal.
    process.kill(pid, 0)
    return true
  } catch (error) {
    // ESRCH means no such process (a true orphan); EPERM means it exists but we may not signal it.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class DockerDriver implements ExecutionDriver {
  constructor(
    private readonly docker: Docker,
    private readonly options: DockerDriverOptions,
  ) {}

  ensureImage(spec: ImageSpec): Promise<ImageRef> {
    const { imageTagPrefix, imagePolicy } = this.options
    if (spec.kind === 'submission-overlay') {
      // The overlay layers onto the base image for its deps version, referenced by tag in the
      // Dockerfile `FROM`; the worker ensures that base exists before requesting an overlay.
      const baseTag = imageTag(imageTagPrefix, {
        kind: 'session-base',
        depsVersion: spec.depsVersion,
      })
      return ensureOverlayImage(
        this.docker,
        imageTagPrefix,
        imagePolicy,
        this.options.overlayBuildTimeoutMs,
        baseTag,
        spec,
      )
    }
    if (spec.kind === 'session-overlay') {
      // The multi-submission composed build (every submission staged into its own per-slot
      // directory) lands in Stage 7.5. Stage 7.4 defines the orchestrator-and-driver seam and
      // exercises it against the fake driver; the real Docker build is not wired here yet.
      throw new Error('session-overlay images are built in Stage 7.5 (multi-submission images)')
    }
    return ensureImage(this.docker, imageTagPrefix, imagePolicy, spec)
  }

  /** Enumerate the overlay images this driver manages, for the Stage 5.4 eviction sweep. */
  listOverlayImages(): Promise<OverlayImage[]> {
    return listOverlayImages(this.docker, this.options.imageTagPrefix)
  }

  /** Remove one image by ref, tolerating an already-absent image. */
  removeImage(ref: string): Promise<void> {
    return removeImage(this.docker, ref)
  }

  async launch(spec: LaunchSpec): Promise<SessionProcess> {
    const container = await this.docker.createContainer(this.createOptions(spec))
    return DockerSessionProcess.start(container)
  }

  /** Map the sandbox profile and session config onto Docker container-create options. */
  private createOptions(spec: LaunchSpec): ContainerCreateOptions {
    const { sandbox } = spec
    const memoryBytes = sandbox.memoryMb * 1024 * 1024
    const binds = sandbox.mounts.map(
      (mount) => `${mount.hostPath}:${mount.containerPath}${mount.readOnly ? ':ro' : ''}`,
    )
    return {
      Image: spec.image.ref,
      Cmd: spec.argv,
      // The orchestrator never overrides the entrypoint; the driver-level sandbox tests do.
      ...(spec.entrypoint ? { Entrypoint: spec.entrypoint } : {}),
      Labels: { [SESSION_LABEL]: spec.sessionId, [OWNER_PID_LABEL]: String(process.pid) },
      Tty: false,
      OpenStdin: true,
      StdinOnce: false,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        NanoCpus: Math.round(sandbox.cpus * 1e9),
        Memory: memoryBytes,
        // Swap equal to memory means the quota is hard: the kernel cannot soften an overage onto swap.
        MemorySwap: memoryBytes,
        ReadonlyRootfs: sandbox.readOnlyRoot,
        Tmpfs: { [sandbox.scratch.containerPath]: `rw,nosuid,size=${sandbox.scratch.sizeMb}m` },
        NetworkMode: sandbox.network,
        Binds: binds.length > 0 ? binds : undefined,
        CapDrop: ['ALL'],
      },
    }
  }

  /**
   * Remove orphaned session containers: those whose creating backend process is no longer alive (a
   * crash or a previous run), plus legacy containers from before the owner-pid label existed. This
   * keeps crashed-backend restarts clean without a supervisor while never touching a *peer* backend's
   * live containers when several share one Docker daemon — its process is still alive, so its
   * containers are skipped rather than killed.
   */
  async reapOrphans(): Promise<void> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [SESSION_LABEL] },
    })
    await Promise.all(
      containers.map(async (info) => {
        const ownerPid = info.Labels?.[OWNER_PID_LABEL]
        const pid = ownerPid !== undefined ? Number.parseInt(ownerPid, 10) : Number.NaN
        // A container whose owner process is still running belongs to a live peer backend; leave it.
        if (Number.isInteger(pid) && isProcessAlive(pid)) {
          return
        }
        const container: Container = this.docker.getContainer(info.Id)
        try {
          await container.remove({ force: true })
        } catch {
          // Raced with another reaper or already gone — nothing to clean up.
        }
      }),
    )
  }
}

/**
 * Build a {@link DockerDriver} against the local daemon and reap any orphaned session containers
 * before returning, so the driver is ready and the host is clean. dockerode's socket defaults
 * suffice on both Windows and Linux.
 */
export async function createDockerDriver(options: DockerDriverOptions): Promise<DockerDriver> {
  const driver = new DockerDriver(new Docker(), options)
  await driver.reapOrphans()
  return driver
}

/**
 * Resolve an image tag directly, without constructing a full driver. The `build:image` CLI shortcut
 * (see `build-image.ts`) uses this to refresh the session base image ahead of a session, so it
 * neither reaps the containers a running backend supervises nor needs the rest of the driver. It is
 * the one seam that hands {@link ensureImage} a daemon connection from outside this folder, keeping
 * the `new Docker()` inside the import-isolation boundary; the build path itself — the repo-root
 * context, the ignore list, and the deps-version tag — is exactly the one a session launch uses.
 */
export function buildImage(
  options: DockerDriverOptions,
  spec: SessionBaseImageSpec,
): Promise<ImageRef> {
  return ensureImage(new Docker(), options.imageTagPrefix, options.imagePolicy, spec)
}
