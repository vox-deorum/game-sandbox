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
 * Stage 5 resolves a session's version per submission from its manifest, so a live session's spec
 * will no longer be this fixed default; building the base image still needs a current default, which
 * is what this remains.
 */
import type { ImageSpec } from './driver/index.js'

/** The current dependency-set version `N`, tagged `…:deps-v<N>`. This stage uses only v1. */
export const DEPS_VERSION = 1

/** The session base image spec for {@link DEPS_VERSION} — the one place that pairs kind and version. */
export function currentSessionBaseImageSpec(): ImageSpec {
  return { kind: 'session-base', depsVersion: DEPS_VERSION }
}
