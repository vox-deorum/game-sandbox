/**
 * `npm run build:image`: build (or rebuild) the session base image from the monorepo sources — the
 * same image the backend otherwise builds lazily on the first session launch.
 *
 * It exists because the default `reuse` image policy keeps an existing tag forever, so there is no
 * other single-command way to refresh the image after the Dockerfile or a bundled source (the
 * harness, an environment, or the built-in agent) changes. It reuses the Docker driver's own build
 * path — the repo-root context, the ignore list, the deps-version tag — so what it produces is
 * exactly what a session launch would, and it always rebuilds regardless of the configured policy.
 */
import { loadConfig } from './config.js'
import { currentSessionBaseImageSpec } from './deps-version.js'
import { buildImage } from './driver/docker/index.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const ref = await buildImage(
    { ...config.docker, imagePolicy: 'rebuild' },
    currentSessionBaseImageSpec(),
  )
  console.error(`built ${ref.ref}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
