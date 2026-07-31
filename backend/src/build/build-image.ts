/**
 * `npm run build:image`: build (or rebuild) the session base image from the monorepo sources — the
 * same image the backend otherwise builds lazily on the first session launch.
 *
 * It exists because the default `reuse` image policy keeps an existing tag forever, so there is no
 * other single-command way to refresh the current version's image after its registered Dockerfile
 * or a bundled source (the harness, an environment, or the built-in agent) changes. It reuses the
 * Docker driver's own build path, including the version-specific image definition, so what it
 * produces is exactly what a session launch would, and it always rebuilds regardless of the
 * configured policy.
 */
import { loadDockerOptions } from '../config/config.js'
import { buildImage } from '../driver/docker/index.js'
import { currentSessionBaseImageSpec } from './deps-version.js'

async function main(): Promise<void> {
  // Only the Docker options are needed here, so parse just that slice: building an image must not
  // require the auth secret and bootstrap credentials a full `loadConfig` demands.
  const docker = loadDockerOptions()
  const ref = await buildImage({ ...docker, imagePolicy: 'rebuild' }, currentSessionBaseImageSpec())
  console.error(`built ${ref.ref}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
