import type { SandboxDefaults } from '../config/config.js'
import type { SandboxOverride } from '../storage/season-config.js'
import type { GpuBusyPolicy, MountSpec, SandboxNetwork, SandboxProfile } from './index.js'

/** The only writable path exposed inside a sandboxed backend-launched container. */
const SCRATCH_CONTAINER_PATH = '/tmp'

/** One container's quotas: the deployment defaults, plus whether the container leases a GPU. */
export interface SandboxResources extends SandboxDefaults {
  gpu?: boolean
}

/** Apply a season's `overrides.sandbox` block to the deployment defaults. */
export function sandboxResourcesForSeason(
  defaults: SandboxDefaults,
  override: SandboxOverride | undefined,
): SandboxResources {
  return {
    ...defaults,
    cpus: override?.cpus ?? defaults.cpus,
    memoryMb: override?.memory_mb ?? defaults.memoryMb,
    gpu: override?.gpu === true,
  }
}

/** Derive a session profile from its base quota and the players loaded into one container. */
export function sandboxResourcesForPlayers<T extends SandboxDefaults>(
  resources: T,
  playerCount: number,
): T {
  const increment = resources.memoryPerPlayerMb * (playerCount - 1)
  const memoryMb = resources.memoryMb + increment
  return { ...resources, memoryMb }
}

/**
 * Build the hardened sandbox profile shared by live sessions, workflow games, and submission load
 * checks. Callers choose quotas and the mounts their job needs; the security posture is fixed here.
 * `gpuWhenBusy` only matters when the resources ask for a GPU.
 */
export function buildSandboxProfile(
  resources: SandboxResources,
  mounts: readonly MountSpec[],
  network: SandboxNetwork = 'none',
  gpuWhenBusy: GpuBusyPolicy = 'wait',
): SandboxProfile {
  return {
    cpus: resources.cpus,
    memoryMb: resources.memoryMb,
    readOnlyRoot: true,
    scratch: {
      containerPath: SCRATCH_CONTAINER_PATH,
      sizeMb: resources.scratchMb,
    },
    network,
    mounts: [...mounts],
    pids: resources.pids,
    ...(resources.gpu === true ? { gpu: { whenBusy: gpuWhenBusy } } : {}),
  }
}
