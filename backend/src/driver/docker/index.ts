/**
 * The local Docker execution driver: the first and, for now, only {@link ExecutionDriver}.
 *
 * It maps the driver-neutral {@link SandboxProfile} straight onto Docker's `HostConfig` and carries
 * the session's line channel over attached stdio (see {@link DockerSessionProcess}). This folder is
 * the one place `dockerode` may be imported — the Biome import-isolation rule enforces it — so a
 * Kubernetes driver lands as a sibling implementing the same interface with nothing above it
 * changing. Image caching lives here too, as the {@link DockerDriverOptions.imagePolicy}.
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import type { Container, ContainerCreateOptions, Network } from 'dockerode'
import Docker from 'dockerode'

import type { DockerDriverOptions } from '../../config/config.js'
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
import {
  ensureOverlayImage,
  ensureSessionOverlayImage,
  listOverlayImages,
  removeImage,
} from './overlay.js'
import { DockerSessionProcess } from './session-process.js'

/** The label every session container carries, keyed by session id, for supervision and reaping. */
const SESSION_LABEL = 'game-sandbox.session'
/**
 * The OS process id of the backend that created the container. Reaping uses it to tell a true
 * orphan (a container whose creating process is gone — a crashed or previous backend) from a peer
 * backend's live container when several share one Docker daemon. Only the former is reaped.
 */
const OWNER_PID_LABEL = 'game-sandbox.owner-pid'
/** Driver-owned resources that make the backend proxy the internal network's only service. */
const LLM_NETWORK_LABEL = 'game-sandbox.llm-network'
const LLM_RELAY_LABEL = 'game-sandbox.llm-relay'
const LLM_RELAY_IMAGE = 'alpine/socat:1.8.0.3'

interface LlmNetworkResources {
  networkName: string
  cleanup: () => Promise<void>
}

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

/**
 * The backend process's own container id, read from its cgroup path when it runs inside Docker
 * (compose attaches this container to the internal network, whose inspect data keys endpoints by
 * container id). `undefined` when the process is not containerized under a 64-hex-id cgroup (the
 * host-process dev mode), which is exactly when the caller should not rely on the internal network.
 */
async function ownContainerId(): Promise<string | undefined> {
  let cgroup: string
  try {
    cgroup = await readFile('/proc/self/cgroup', 'utf-8')
  } catch {
    return undefined
  }
  return /(?:docker|containerd)[-/]([0-9a-f]{64})/i.exec(cgroup)?.[1]
}

export class DockerDriver implements ExecutionDriver {
  private relayImageReady: Promise<void> | undefined

  constructor(
    private readonly docker: Docker,
    private readonly options: DockerDriverOptions,
    private readonly llmInternalPort?: number,
  ) {}

  ensureImage(spec: ImageSpec): Promise<ImageRef> {
    const { imageTagPrefix, imagePolicy } = this.options
    if (spec.kind === 'session-base') {
      return ensureImage(this.docker, imageTagPrefix, imagePolicy, spec)
    }
    // Both overlay kinds layer onto the base image for their deps version, referenced by tag in the
    // Dockerfile `FROM`; the caller ensures that base exists before requesting an overlay.
    const baseTag = imageTag(imageTagPrefix, {
      kind: 'session-base',
      depsVersion: spec.depsVersion,
    })
    const { overlayBuildTimeoutMs } = this.options
    if (spec.kind === 'submission-overlay') {
      return ensureOverlayImage(
        this.docker,
        imageTagPrefix,
        imagePolicy,
        overlayBuildTimeoutMs,
        baseTag,
        spec,
      )
    }
    // A composed multi-agent session image: one COPY chained per submitted seat, each
    // into its own per-seat directory (see ensureSessionOverlayImage).
    return ensureSessionOverlayImage(
      this.docker,
      imageTagPrefix,
      imagePolicy,
      overlayBuildTimeoutMs,
      baseTag,
      spec,
    )
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
    let llm: LlmNetworkResources | undefined
    try {
      if (spec.sandbox.network === 'llm') {
        llm = await this.createLlmNetwork(spec.sessionId)
      }
      const container = await this.docker.createContainer(
        this.createOptions(spec, llm?.networkName ?? 'none'),
      )
      return await DockerSessionProcess.start(container, llm?.cleanup)
    } catch (error) {
      await llm?.cleanup().catch(() => undefined)
      throw error
    }
  }

  /**
   * The interface the internal LLM listener should bind to for the configured relay topology. A
   * compose-network relay reaches the backend over the shared internal network, so the listener
   * binds that network's interface only, never the outbound or host-facing ones. The host-gateway
   * relay (dev / host process) must stay reachable through the docker gateway, so it binds all
   * interfaces. Returns `undefined` when the internal interface cannot be discovered; the caller
   * logs loudly and falls back to all interfaces rather than silently breaking LLM.
   */
  async llmListenHost(): Promise<string | undefined> {
    if (this.options.llmRelay.mode === 'host-gateway') {
      return '0.0.0.0'
    }
    const ownId = await ownContainerId()
    if (ownId === undefined) return undefined
    const network = await this.docker
      .getNetwork(this.options.llmRelay.network)
      .inspect()
      .catch(() => undefined)
    const endpoint = network?.Containers?.[ownId]
    const host = endpoint?.IPv4Address?.split('/')[0]
    return host === undefined || host === '' ? undefined : host
  }

  /** Create one agent-only bridge and connect its relay through the configured fixed topology. */
  private async createLlmNetwork(sessionId: string): Promise<LlmNetworkResources> {
    if (this.llmInternalPort === undefined) {
      throw new Error('LLM_INTERNAL_PORT is required to launch an LLM-enabled sandbox')
    }
    await this.ensureRelayImage()

    const resourceId = `${process.pid}-${randomUUID()}`
    const networkName = `game-sandbox-llm-${resourceId}-agent`
    const egressNetworkName = `game-sandbox-llm-${resourceId}-egress`
    const labels = {
      [SESSION_LABEL]: sessionId,
      [OWNER_PID_LABEL]: String(process.pid),
    }
    const network = await this.docker.createNetwork({
      Name: networkName,
      Internal: true,
      Labels: { ...labels, [LLM_NETWORK_LABEL]: 'agent' },
    })
    let egressNetwork: Network | undefined
    let relay: Container | undefined
    let cleanupPromise: Promise<void> | undefined
    const cleanup = (): Promise<void> => {
      cleanupPromise ??= (async () => {
        await relay?.remove({ force: true }).catch(() => undefined)
        await network.remove().catch(() => undefined)
        await egressNetwork?.remove().catch(() => undefined)
      })()
      return cleanupPromise
    }

    try {
      const relayTopology = this.options.llmRelay
      if (relayTopology.mode === 'host-gateway') {
        // Only the trusted relay joins this routed bridge. The submitted-agent container stays on
        // the internal bridge, where there is no gateway route and no host-gateway alias.
        egressNetwork = await this.docker.createNetwork({
          Name: egressNetworkName,
          Internal: false,
          Labels: { ...labels, [LLM_NETWORK_LABEL]: 'egress' },
        })
      }
      const relayNetwork =
        relayTopology.mode === 'host-gateway' ? egressNetworkName : relayTopology.network
      const relayTarget =
        relayTopology.mode === 'host-gateway' ? 'host.docker.internal' : relayTopology.host
      relay = await this.docker.createContainer({
        Image: LLM_RELAY_IMAGE,
        Entrypoint: ['socat'],
        Cmd: [
          '-d',
          '-d',
          `TCP-LISTEN:${this.llmInternalPort},fork,reuseaddr`,
          `TCP:${relayTarget}:${this.llmInternalPort}`,
        ],
        Labels: { ...labels, [LLM_RELAY_LABEL]: 'true' },
        HostConfig: {
          NetworkMode: relayNetwork,
          ...(relayTopology.mode === 'host-gateway'
            ? { ExtraHosts: ['host.docker.internal:host-gateway'] }
            : {}),
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges:true'],
          PidsLimit: 64,
        },
        NetworkingConfig: {
          EndpointsConfig: { [relayNetwork]: {} },
        },
      })
      // The relay exposes exactly one fixed-destination socat listener to agents. It has no shell or
      // dynamic proxy surface through which an agent can select another host or destination port.
      await network.connect({
        Container: relay.id,
        EndpointConfig: { Aliases: ['llm-proxy'] },
      })
      await relay.start()
      return { networkName, cleanup }
    } catch (error) {
      await cleanup()
      throw error
    }
  }

  /** Pull the small pinned relay image once per driver when it is not already present. */
  private ensureRelayImage(): Promise<void> {
    this.relayImageReady ??= (async () => {
      try {
        await this.docker.getImage(LLM_RELAY_IMAGE).inspect()
        return
      } catch {
        const stream = await this.docker.pull(LLM_RELAY_IMAGE)
        await new Promise<void>((resolve, reject) => {
          this.docker.modem.followProgress(stream, (error: Error | null) => {
            if (error) reject(error)
            else resolve()
          })
        })
      }
    })().catch((error: unknown) => {
      this.relayImageReady = undefined
      throw error
    })
    return this.relayImageReady
  }

  /** Map the sandbox profile and session config onto Docker container-create options. */
  private createOptions(spec: LaunchSpec, networkMode: string): ContainerCreateOptions {
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
        // `mode=1777` keeps the scratch writable by the non-root session user; `nodev`/`nosuid` keep a
        // device or setuid helper out of the only writable path. `exec` stays on: /tmp also serves as
        // the student run directory.
        Tmpfs: {
          [sandbox.scratch.containerPath]:
            `rw,nosuid,nodev,mode=1777,size=${sandbox.scratch.sizeMb}m`,
        },
        NetworkMode: networkMode,
        Binds: binds.length > 0 ? binds : undefined,
        CapDrop: ['ALL'],
        // Blocks setuid-binary privilege gain inside the container even before the non-root user.
        SecurityOpt: ['no-new-privileges:true'],
        // A fork bomb may not drain the shared host pid table.
        PidsLimit: sandbox.pids,
      },
    }
  }

  /**
   * Remove orphaned session containers: those whose creating backend process is no longer alive (a
   * crash or a previous run), plus legacy containers from before the owner-pid label existed. This
   * keeps crashed-backend restarts clean without a supervisor while never touching a *peer* backend's
   * live containers when several share one Docker daemon — its process is still alive, so its
   * containers are skipped rather than killed.
   *
   * Pid liveness is namespace-local, so a label carrying this process's own pid is never a live peer:
   * reapOrphans runs before this process has created anything, so it can only be a previous
   * incarnation whose pid namespace restarted. A containerized backend is pid 1 on every boot, and
   * must be the only backend using its Docker daemon, so this rule always applies there; the
   * peer-backend courtesy above applies only to host-process peers sharing a host daemon.
   */
  async reapOrphans(): Promise<void> {
    const [sessionContainers, relayContainers] = await Promise.all([
      this.docker.listContainers({ all: true, filters: { label: [SESSION_LABEL] } }),
      this.docker.listContainers({ all: true, filters: { label: [LLM_RELAY_LABEL] } }),
    ])
    const containers = [
      ...new Map(
        [...sessionContainers, ...relayContainers].map((info) => [info.Id, info]),
      ).values(),
    ]
    await Promise.all(
      containers.map(async (info) => {
        const ownerPid = info.Labels?.[OWNER_PID_LABEL]
        const pid = ownerPid !== undefined ? Number.parseInt(ownerPid, 10) : Number.NaN
        // A container whose owner process is still running belongs to a live peer backend; leave it.
        // A container labeled with our own pid can only be a previous incarnation (pid namespaces
        // restart in a container), never us, so it is always reaped.
        if (Number.isInteger(pid) && pid !== process.pid && isProcessAlive(pid)) {
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

    // Relay and session containers must be gone before Docker will remove their shared network.
    const networks = await this.docker.listNetworks({ filters: { label: [LLM_NETWORK_LABEL] } })
    await Promise.all(
      networks.map(async (info) => {
        const ownerPid = info.Labels?.[OWNER_PID_LABEL]
        const pid = ownerPid !== undefined ? Number.parseInt(ownerPid, 10) : Number.NaN
        if (Number.isInteger(pid) && pid !== process.pid && isProcessAlive(pid)) {
          return
        }
        const network: Network = this.docker.getNetwork(info.Id)
        try {
          await network.remove()
        } catch {
          // An attachment may have raced this sweep; the next startup sweep retries the network.
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
export async function createDockerDriver(
  options: DockerDriverOptions,
  llmInternalPort?: number,
): Promise<DockerDriver> {
  const docker = new Docker()
  if (options.llmRelay.mode === 'compose-network') {
    try {
      await docker.getNetwork(options.llmRelay.network).inspect()
    } catch {
      throw new Error(
        `DOCKER_LLM_RELAY_NETWORK ${options.llmRelay.network} does not exist or is not accessible to the Docker daemon`,
      )
    }
  }
  const driver = new DockerDriver(docker, options, llmInternalPort)
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
