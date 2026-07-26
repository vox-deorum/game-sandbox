import type { SandboxDefaults } from '../config.js'
import type { MountSpec, SandboxNetwork, SandboxProfile } from './index.js'

/** The only writable path exposed inside a sandboxed backend-launched container. */
const SCRATCH_CONTAINER_PATH = '/tmp'

/** Derive a session profile from its base quota and the players loaded into one container. */
export function sandboxResourcesForPlayers(
  resources: SandboxDefaults,
  playerCount: number,
): SandboxDefaults {
  if (!Number.isSafeInteger(playerCount) || playerCount < 1) {
    throw new Error(`player count must be a positive safe integer, got ${playerCount}`)
  }
  const increment = resources.memoryPerPlayerMb * (playerCount - 1)
  const memoryMb = resources.memoryMb + increment
  if (!Number.isSafeInteger(increment) || !Number.isSafeInteger(memoryMb) || memoryMb <= 0) {
    throw new Error('sandbox memory quota is not a positive safe integer')
  }
  return { ...resources, memoryMb }
}

/**
 * Build the hardened sandbox profile shared by live sessions, workflow games, and submission load
 * checks. Callers choose quotas and the mounts their job needs; the security posture is fixed here.
 */
export function buildSandboxProfile(
  resources: SandboxDefaults,
  mounts: readonly MountSpec[],
  network: SandboxNetwork = 'none',
): SandboxProfile {
  return {
    cpus: resources.cpus,
    memoryMb: resources.memoryMb,
    readOnlyRoot: true,
    scratch: { containerPath: SCRATCH_CONTAINER_PATH, sizeMb: resources.scratchMb },
    network,
    mounts: [...mounts],
  }
}
