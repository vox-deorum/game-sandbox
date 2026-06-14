/**
 * The platform's current dependency-set version, and the session base image it resolves to.
 *
 * The version `N` is one number wearing several hats: the `template-v<N>` release tag, the pinned set
 * compiled into `templates/base/requirements.txt`, the `…:deps-v<N>` session image tag, and the
 * `template_version` an agent manifest targets (see [examples and the template](../../docs/contributors/examples-and-template.md)).
 * This module is that number's single home on the backend, so the orchestrator (which requests a
 * session's image), the `build:image` shortcut, and the integration harness all name the same `N` —
 * bump it here when a new dependency set is cut.
 *
 * Stage 5 resolves a submission's version from its iteration's pinned `deps_version` and only
 * validates that the submission manifest's `template_version` matches it; the overlay build and the
 * watch run both take the version from the iteration, not the manifest directly. So a submitted-agent
 * session's spec is the iteration's version rather than this fixed default. Building the base image
 * still needs a current default, which is what this remains.
 */
import type { ImageSpec } from './driver/index.js'

/** The current dependency-set version `N`, tagged `…:deps-v<N>`. This stage uses only v1. */
export const DEPS_VERSION = 1

/** The session base image spec for {@link DEPS_VERSION} — the one place that pairs kind and version. */
export function currentSessionBaseImageSpec(): ImageSpec {
  return { kind: 'session-base', depsVersion: DEPS_VERSION }
}
