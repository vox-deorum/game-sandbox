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
import type { ExecutionDriver, ImageRef, ImageSpec, LaunchSpec, SessionProcess } from '../index.js'
import { ensureImage } from './image.js'
import { DockerSessionProcess } from './session-process.js'

/** The label every session container carries, keyed by session id, for supervision and reaping. */
const SESSION_LABEL = 'game-sandbox.session'

export class DockerDriver implements ExecutionDriver {
  constructor(
    private readonly docker: Docker,
    private readonly options: DockerDriverOptions,
  ) {}

  ensureImage(spec: ImageSpec): Promise<ImageRef> {
    return ensureImage(this.docker, this.options.imageTagPrefix, this.options.imagePolicy, spec)
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
      Labels: { [SESSION_LABEL]: spec.sessionId },
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
   * Kill and remove every container carrying the session label. On construction these belong to a
   * previous backend process whose sessions no longer exist, so reaping keeps crashed-backend
   * restarts clean without a supervisor.
   */
  async reapOrphans(): Promise<void> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [SESSION_LABEL] },
    })
    await Promise.all(
      containers.map(async (info) => {
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
