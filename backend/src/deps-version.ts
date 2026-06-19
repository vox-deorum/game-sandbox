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
 * Stage 5 resolves a submission's version from its season's pinned `deps_version` and only
 * validates that the submission manifest's `template_version` matches it; the overlay build and the
 * watch run both take the version from the season, not the manifest directly. So a submitted-agent
 * session's spec is the season's version rather than this fixed default. Building the base image
 * still needs a current default, which is what this remains.
 */
import type { ImageSpec } from './driver/index.js'

/** The current dependency-set version `N`, tagged `…:deps-v<N>`. This stage uses only v1. */
export const DEPS_VERSION = 1

/**
 * Every dependency-set version the deployment can serve, as the inclusive range from the first
 * deps-pinned release (v1) through {@link DEPS_VERSION}. A season may pin any of these — each
 * released version keeps its `…:deps-v<N>` base image — so the submission static check accepts a
 * manifest whose `template_version` names any supported version, then separately requires it to
 * equal the season's pinned version. Keeping this distinct from the single current default means
 * bumping `DEPS_VERSION` leaves older still-supported seasons accepting resubmissions instead of
 * rejecting their (still valid) manifests as `unknown_template_version`.
 */
export const KNOWN_DEPS_VERSIONS: ReadonlySet<number> = new Set(
  Array.from({ length: DEPS_VERSION }, (_, index) => index + 1),
)

/** The session base image spec for {@link DEPS_VERSION} — the one place that pairs kind and version. */
export function currentSessionBaseImageSpec(): ImageSpec {
  return { kind: 'session-base', depsVersion: DEPS_VERSION }
}
