/**
 * `npm run build:image`: make the current session base image fresh, building it only when needed.
 *
 * Every build stamps the image with a digest of its inputs (the versioned Dockerfile directory,
 * the harness, and the environments package), so this command reuses the existing tag when nothing
 * changed and rebuilds it, with the daemon's build log streamed live, when something did. That
 * makes it safe to run habitually, which is what the e2e job does before every suite. `--force`
 * rebuilds unconditionally, the escape hatch for input changes the digest cannot see, such as an
 * updated upstream `python:3.12-slim`: run `npm run build:image -- --force` from `backend/`. (In
 * PowerShell use `npm.cmd`; the npm PowerShell wrapper strips the bare `--`, so the flag never
 * reaches this script.)
 */
import { loadDockerOptions } from '../config/config.js'
import { buildImage } from '../driver/docker/index.js'
import { currentSessionBaseImageSpec } from './deps-version.js'

async function main(): Promise<void> {
  // Only the Docker options are needed here, so parse just that slice: building an image must not
  // require the auth secret and bootstrap credentials a full `loadConfig` demands.
  const docker = loadDockerOptions()
  const policy = process.argv.includes('--force') ? 'rebuild' : 'refresh'
  const ref = await buildImage(docker, currentSessionBaseImageSpec(), policy)
  console.error(`image ready: ${ref.ref}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
