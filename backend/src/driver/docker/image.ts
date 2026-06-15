/**
 * Image resolution for the Docker driver: turn an {@link ImageSpec} into a launch-ready tag,
 * building the session base image when it is absent or when the policy demands a rebuild.
 *
 * Whether an existing tag is reused or always rebuilt is driver configuration ({@link ImagePolicy}),
 * not caller policy — the orchestrator asks for an image and gets back a tag. The build context is
 * the repo root, because the base image is assembled from monorepo sources (see the Dockerfile);
 * the heavy, irrelevant directories are excluded from the tar so only the sources the Dockerfile
 * copies are sent to the daemon.
 */
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import type Docker from 'dockerode'
import tar from 'tar-fs'
import type { ImagePolicy } from '../../config.js'
import type { ImageRef, ImageSpec } from '../index.js'

/** backend/src/driver/docker/image.ts → repo root is four directories up. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const DOCKERFILE = 'backend/images/session-base/Dockerfile'
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

/** Directories and files never worth sending to the daemon as build context. */
const IGNORED_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.venv',
  'build',
  'data',
  'dist',
  '.pytest-tmp',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '__pycache__',
])

/** The tag for a spec under a prefix: this stage's only kind is the session base image per deps version. */
export function imageTag(prefix: string, spec: ImageSpec): string {
  return `${prefix}/session-base:deps-v${spec.depsVersion}`
}

/** True when an outer-edge ignored directory or a compiled-Python artifact sits on this path. */
function isIgnored(absolutePath: string): boolean {
  const rel = relative(REPO_ROOT, absolutePath)
  if (rel === '' || rel.startsWith('..')) {
    return false
  }
  if (rel.endsWith('.pyc')) {
    return true
  }
  return rel.split(sep).some((segment) => IGNORED_SEGMENTS.has(segment))
}

async function imageExists(docker: Docker, tag: string): Promise<boolean> {
  try {
    await docker.getImage(tag).inspect()
    return true
  } catch {
    return false
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
async function build(docker: Docker, tag: string): Promise<void> {
  const context = tar.pack(REPO_ROOT, { ignore: isIgnored })
  const buildStream = await docker.buildImage(context, { t: tag, dockerfile: DOCKERFILE })
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
      () => undefined,
    )
  })
}

/**
 * Cold CI runners sometimes hit transient Docker Hub or package-index timeouts while resolving the
 * base layers. Retry only those network-shaped failures so real Dockerfile errors still fail fast.
 */
async function buildWithRetry(docker: Docker, tag: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await build(docker, tag)
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
 * existing tag is returned untouched; under `rebuild` the image is always rebuilt.
 */
export async function ensureImage(
  docker: Docker,
  prefix: string,
  policy: ImagePolicy,
  spec: ImageSpec,
): Promise<ImageRef> {
  const tag = imageTag(prefix, spec)
  if (policy === 'reuse' && (await imageExists(docker, tag))) {
    return { ref: tag }
  }
  await buildWithRetry(docker, tag)
  return { ref: tag }
}
