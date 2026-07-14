/**
 * Application-lifetime access to public environment metadata. Every consumer shares the same request
 * and successful result; a rejected request is forgotten so a later navigation can retry.
 */
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'

import { getEnvironments } from './api/client.js'

let cached: EnvironmentMeta[] | null = null
let inFlight: Promise<EnvironmentMeta[]> | null = null

/** Load the public environment catalog, sharing both an active request and its successful result. */
export function loadEnvironmentCatalog(): Promise<EnvironmentMeta[]> {
  if (cached !== null) return Promise.resolve(cached)
  if (inFlight !== null) return inFlight

  inFlight = getEnvironments().then(
    (environments) => {
      cached = environments
      inFlight = null
      return environments
    },
    (error: unknown) => {
      inFlight = null
      throw error
    },
  )
  return inFlight
}

/** Resolve one environment from the shared catalog. */
export async function environmentMeta(envId: string): Promise<EnvironmentMeta | null> {
  return (
    (await loadEnvironmentCatalog()).find((environment) => environment.env_id === envId) ?? null
  )
}

/** Clear application-lifetime catalog state. Tests use this to isolate cache and retry scenarios. */
export function resetEnvironmentCatalog(): void {
  cached = null
  inFlight = null
}
