/**
 * Integration-suite global setup: confirm the Docker daemon is reachable, then build the session
 * base image once (reuse — present means skip). Every integration test launches real containers
 * against this image, so building it here keeps the per-test cost to a single launch.
 */
import Docker from 'dockerode'

import { ensureBaseImage } from './support/base-image.js'

export default async function setup(): Promise<void> {
  try {
    await new Docker().ping()
  } catch (error) {
    throw new Error(
      `the backend integration suite needs a reachable Docker daemon, but the ping failed: ${String(error)}`,
    )
  }
  await ensureBaseImage('reuse')
}
