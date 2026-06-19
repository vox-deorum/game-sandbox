/**
 * The season seed: one open season per registered environment at the current dependency-set
 * version, so every submission has an identity boundary and a pinned `deps_version` to attach to.
 *
 * This is the deliberately minimal stand-in Stage 5 calls for, enough identity and version for
 * submissions, nothing of Stage 6's operator configuration. It is idempotent: it calls the storage
 * `ensureOpenSeason` primitive per environment, so a restart against an existing database is a
 * no-op and an environment already carrying an open season is left untouched. Stage 6 replaces
 * this with the operator admin console and open/close controls.
 */
import type { EnvironmentRegistry } from './environments.js'
import type { Storage } from './storage/index.js'

/** Ensure every environment in the registry has an open season at `depsVersion`. */
export async function seedOpenSeasons(
  storage: Storage,
  environments: EnvironmentRegistry,
  depsVersion: number,
): Promise<void> {
  for (const meta of environments.list()) {
    await storage.ensureOpenSeason(meta.env_id, depsVersion)
  }
}
