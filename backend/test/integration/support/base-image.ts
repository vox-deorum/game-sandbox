/**
 * Build (or reuse) the session base image for the integration suite.
 *
 * The integration tests need the real image: a scripted session that plays Flappy Bird, and
 * driver-level launches that exercise the sandbox profile. Building it is expensive, so the global
 * setup does it once with the `reuse` policy — present means skip. Individual tests import
 * {@link BASE_IMAGE_REF} to launch against it.
 */

import { imageTag } from '../../../src/driver/docker/image.js'
import { createDockerDriver } from '../../../src/driver/docker/index.js'
import type { ImageRef } from '../../../src/driver/index.js'

export const DEPS_VERSION = 1
export const TAG_PREFIX = 'game-sandbox'

/** The tag the base image is built under, for tests that reference it directly. */
export const BASE_IMAGE_REF: ImageRef = {
  ref: imageTag(TAG_PREFIX, { kind: 'session-base', depsVersion: DEPS_VERSION }),
}

/** Build the base image if absent (`reuse`) or unconditionally (`rebuild`), returning its ref. */
export async function ensureBaseImage(policy: 'reuse' | 'rebuild' = 'reuse'): Promise<ImageRef> {
  const driver = await createDockerDriver({ imageTagPrefix: TAG_PREFIX, imagePolicy: policy })
  return driver.ensureImage({ kind: 'session-base', depsVersion: DEPS_VERSION })
}
