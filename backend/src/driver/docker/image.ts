/**
 * Image resolution for the Docker driver: turn an {@link ImageSpec} into a launch-ready tag,
 * building the session base image when it is absent or when the policy demands it.
 *
 * Whether an existing tag is reused or rebuilt is driver configuration ({@link ImagePolicy}), not
 * caller policy: the orchestrator asks for an image and gets back a tag. The `build:image` CLI adds
 * a third, internal-only `refresh` policy: every build stamps the digest of its inputs onto the
 * image as a label, and refresh reuses the tag when that label still matches the checkout, so the
 * command is cheap when nothing changed. The build context is the repo root, because the base image
 * is assembled from monorepo sources (see the Dockerfile); the tar packs only the definition's
 * registered input trees (plus the ancestor directory entries needed to reach them), so only the
 * sources the Dockerfile copies are sent to the daemon.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type Docker from 'dockerode'
import tar from 'tar-fs'
import { sessionBaseImageDefinition, sessionBaseImageInputs } from '../../build/deps-version.js'
import type { ImagePolicy } from '../../config/config.js'
import type { ImageRef, SessionBaseImageSpec } from '../index.js'
import { buildContextIgnore, computeBuildInputsDigest } from './build-inputs.js'

/** backend/src/driver/docker/image.ts → repo root is four directories up. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const BUILD_RETRY_DELAYS_MS = [2_000, 8_000, 20_000]
const TRANSIENT_BUILD_ERROR = new RegExp(
  [
    'context deadline exceeded',
    'Client\\.Timeout exceeded',
    'TLS handshake timeout',
    'i/o timeout',
    'temporary failure',
    'connection reset',
    'unexpected EOF',
    '502 Bad Gateway',
    '503 Service Unavailable',
    '504 Gateway Timeout',
  ].join('|'),
  'i',
)

/**
 * The label every base-image build stamps with the digest of its inputs, read back by the
 * `refresh` policy to decide whether the tag is still fresh.
 */
const BUILD_INPUTS_DIGEST_LABEL = 'game-sandbox.build-inputs-digest'

/** {@link ImagePolicy} plus `refresh`, which reuses an existing tag only while its inputs digest matches. */
export type EnsureImagePolicy = ImagePolicy | 'refresh'

/** The tag for a supported session base image under a deployment prefix. */
export function imageTag(prefix: string, spec: SessionBaseImageSpec): string {
  // Refuse to name a tag the deployment cannot build; throws for an unregistered version.
  sessionBaseImageDefinition(spec.depsVersion)
  return `${prefix}/session-base:deps-v${spec.depsVersion}`
}

/** The digest label of an existing tag: undefined when the tag or the label is absent. */
async function imageInputsLabel(docker: Docker, tag: string): Promise<string | undefined> {
  try {
    const info = await docker.getImage(tag).inspect()
    return info.Config?.Labels?.[BUILD_INPUTS_DIGEST_LABEL] ?? 'unlabeled'
  } catch {
    return undefined
  }
}

interface BuildProgress {
  stream?: string
  error?: string
  errorDetail?: { message?: string }
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function isTransientBuildError(error: unknown): boolean {
  return TRANSIENT_BUILD_ERROR.test(errorText(error))
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** Build the session base image from the repo-root context, rejecting on any build-step error. */
async function build(
  docker: Docker,
  tag: string,
  dockerfile: string,
  inputsDigest: string,
  inputs: readonly string[],
): Promise<void> {
  console.error(`building ${tag} from ${dockerfile}`)
  const context = tar.pack(REPO_ROOT, { ignore: buildContextIgnore(REPO_ROOT, inputs) })
  const buildStream = await docker.buildImage(context, {
    t: tag,
    dockerfile,
    labels: { [BUILD_INPUTS_DIGEST_LABEL]: inputsDigest },
  })
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      buildStream,
      (err: Error | null, output: BuildProgress[]) => {
        if (err) {
          reject(err)
          return
        }
        // A failing RUN surfaces as an `error` entry in the progress stream, not a stream error.
        const failure = output.find((entry) => entry.error)
        if (failure) {
          reject(new Error(failure.errorDetail?.message ?? failure.error ?? 'image build failed'))
          return
        }
        resolve()
      },
      // Forward the daemon's own build log live so a minutes-long build never looks stuck. The
      // chunks already carry their newlines, so write them raw instead of re-framing per entry.
      (entry: BuildProgress) => {
        if (entry.stream !== undefined) {
          process.stderr.write(entry.stream)
        }
      },
    )
  })
}

/**
 * Cold CI runners sometimes hit transient Docker Hub or package-index timeouts while resolving the
 * base layers. Retry only those network-shaped failures so real Dockerfile errors still fail fast.
 */
async function buildWithRetry(
  docker: Docker,
  tag: string,
  dockerfile: string,
  inputsDigest: string,
  inputs: readonly string[],
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await build(docker, tag, dockerfile, inputsDigest, inputs)
      return
    } catch (error) {
      const delayMs = BUILD_RETRY_DELAYS_MS[attempt]
      if (delayMs === undefined || !isTransientBuildError(error)) {
        throw error
      }
      console.warn(
        `docker build for ${tag} hit a transient registry or network error; retrying in ${
          delayMs / 1000
        }s`,
      )
      await wait(delayMs)
    }
  }
}

/**
 * Resolve `spec` to a launch-ready {@link ImageRef}, building when needed. Under `reuse` an
 * existing tag is returned untouched; under `rebuild` the image is always rebuilt; under `refresh`
 * an existing tag is reused only while its stamped inputs digest matches the checkout, so a
 * pre-label or stale image is rebuilt and a fresh one is returned in seconds.
 */
export async function ensureImage(
  docker: Docker,
  prefix: string,
  policy: EnsureImagePolicy,
  spec: SessionBaseImageSpec,
): Promise<ImageRef> {
  const definition = sessionBaseImageDefinition(spec.depsVersion)
  const tag = imageTag(prefix, spec)
  const label = policy === 'rebuild' ? undefined : await imageInputsLabel(docker, tag)
  if (policy === 'reuse' && label !== undefined) {
    return { ref: tag }
  }
  const inputs = sessionBaseImageInputs(definition)
  const inputsDigest = await computeBuildInputsDigest(REPO_ROOT, inputs)
  if (policy === 'refresh' && label === inputsDigest) {
    console.error(`reusing ${tag} (build inputs unchanged)`)
    return { ref: tag }
  }
  await buildWithRetry(docker, tag, definition.dockerfile, inputsDigest, inputs)
  return { ref: tag }
}
