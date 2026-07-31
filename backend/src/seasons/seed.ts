/**
 * The season seed: one open season per registered environment at the current dependency-set
 * version, so every submission has an identity boundary and a pinned `deps_version` to attach to.
 *
 * The default season is named "Playground" but stays unreleased, so a fresh deployment is playable
 * (submission- and play-open) while its results remain operator-only until the operator releases it.
 * It is idempotent: it calls the storage `ensureOpenSeason` primitive per environment, so a restart
 * against an existing database is a no-op and an environment already carrying an open season is left
 * untouched (its label is never overwritten — the operator renames it from the admin console).
 */
import type { EnvironmentRegistry } from '../environments/registry.js'
import type { Storage } from '../storage/index.js'

/** The label a freshly-seeded default season is stood up with. */
export const DEFAULT_SEASON_LABEL = 'Playground'

/** Ensure every environment in the registry has an open, unreleased "Playground" season at `depsVersion`. */
export async function seedOpenSeasons(
  storage: Storage,
  environments: EnvironmentRegistry,
  depsVersion: number,
): Promise<void> {
  for (const meta of environments.list()) {
    await storage.ensureOpenSeason(meta.env_id, depsVersion, { label: DEFAULT_SEASON_LABEL })
  }
}
