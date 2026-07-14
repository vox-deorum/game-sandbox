import type { SandboxDefaults } from '../config.js'
import type { MountSpec, SandboxProfile } from './index.js'

/** The only writable path exposed inside a sandboxed backend-launched container. */
const SCRATCH_CONTAINER_PATH = '/tmp'

/**
 * Build the hardened sandbox profile shared by live sessions, workflow games, and submission load
 * checks. Callers choose quotas and the mounts their job needs; the security posture is fixed here.
 */
export function buildSandboxProfile(
  resources: SandboxDefaults,
  mounts: readonly MountSpec[],
): SandboxProfile {
  return {
    cpus: resources.cpus,
    memoryMb: resources.memoryMb,
    readOnlyRoot: true,
    scratch: { containerPath: SCRATCH_CONTAINER_PATH, sizeMb: resources.scratchMb },
    network: 'none',
    mounts: [...mounts],
  }
}
