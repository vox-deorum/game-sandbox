import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The current template version, read from the canonical `templates/base/manifest.json`.
 *
 * The backend seeds each season at `DEPS_VERSION` and rejects a submission whose `template_version`
 * does not match, so every agent the e2e suite submits must carry the current version. Reading it from
 * source (rather than hardcoding `1`) keeps a staged manifest in lockstep with a release bump — the
 * same reason the on-disk fixtures under `fixtures/submission/` are rewritten by the bump script.
 */
const manifestPath = fileURLToPath(
  new URL('../../../templates/base/manifest.json', import.meta.url),
)

export const TEMPLATE_VERSION: number = (
  JSON.parse(readFileSync(manifestPath, 'utf8')) as { template_version: number }
).template_version
