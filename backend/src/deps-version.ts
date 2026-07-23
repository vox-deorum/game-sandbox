/**
 * The platform's current dependency-set version, and the session base image it resolves to.
 *
 * The version `N` is one number wearing several hats: the `template-v<N>` release tag, the pinned set
 * compiled into the matching versioned session-image definition, the `…:deps-v<N>` image tag, and
 * the `template_version` an agent manifest targets (see [template releases](../../docs/contributors/template.md)).
 * This module is the backend registry for those released definitions, so validation accepts only
 * versions the deployment can actually build, and the driver never rebuilds an old tag from the
 * current template dependency set by accident.
 *
 * Stage 5 resolves a submission's version from its season's pinned `deps_version` and only
 * validates that the submission manifest's `template_version` matches it; the overlay build and the
 * watch run both take the version from the season, not the manifest directly. So a submitted-agent
 * session's spec is the season's version rather than this fixed default. Building the base image
 * still needs a current default, which is what this remains.
 */
import type { SessionBaseImageSpec } from './driver/index.js'

/**
 * The current dependency-set version `N`, tagged `…:deps-v<N>`. Bumped mechanically at release time by
 * `scripts/bump_template_version.py` (the `export const DEPS_VERSION = <n>` line is its edit anchor —
 * keep the exact shape), which appends the matching {@link SESSION_BASE_IMAGES} entry in the same pass.
 */
export const DEPS_VERSION = 1

/** The immutable build inputs for one dependency-set version's session base image. */
export interface SessionBaseImageDefinition {
  /** Dockerfile path relative to the repository-root build context. */
  readonly dockerfile: string
}

/**
 * The dependency-set versions this checkout can actually serve. This list is deliberately explicit:
 * increasing {@link DEPS_VERSION} does not make every intervening integer valid. A release is added
 * here only together with its version-specific Dockerfile and frozen requirements snapshot — which is
 * exactly what `scripts/bump_template_version.py` appends (a new `[<n>, { dockerfile: '…deps-v<n>…' }],`
 * line before the closing `])`) when a release is cut; keep that line shape so its anchor still matches.
 */
const SESSION_BASE_IMAGES: ReadonlyMap<number, SessionBaseImageDefinition> = new Map([
  [1, { dockerfile: 'backend/images/session-base/deps-v1/Dockerfile' }],
])

/** Every dependency-set version for which this deployment has a concrete base-image definition. */
export const KNOWN_DEPS_VERSIONS: ReadonlySet<number> = new Set(SESSION_BASE_IMAGES.keys())

/** Resolve the immutable build definition for a supported dependency-set version. */
export function sessionBaseImageDefinition(depsVersion: number): SessionBaseImageDefinition {
  const definition = SESSION_BASE_IMAGES.get(depsVersion)
  if (definition === undefined) {
    throw new Error(`unsupported dependency-set version ${depsVersion}`)
  }
  return definition
}

if (!KNOWN_DEPS_VERSIONS.has(DEPS_VERSION)) {
  throw new Error(`current dependency-set version ${DEPS_VERSION} has no base-image definition`)
}

/** The session base image spec for {@link DEPS_VERSION} — the one place that pairs kind and version. */
export function currentSessionBaseImageSpec(): SessionBaseImageSpec {
  return { kind: 'session-base', depsVersion: DEPS_VERSION }
}
