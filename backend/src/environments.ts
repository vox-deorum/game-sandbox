/**
 * Typed access to the generated environment metadata.
 *
 * The metadata registry lives in Python; the backend never runs Python, so it reads a
 * generated, committed JSON artifact (`generated/environments.json`, written by
 * `scripts/generate.py` from `discover_environments()` and kept fresh by the
 * `generated-code-fresh` CI job). This module parses the file once at startup, validates its
 * shape with a small hand-written guard (deliberately not part of the state schema), and
 * exposes typed lookups: the HTTP layer serves the list verbatim and the orchestrator reads
 * pace interval, human-capable slots, and default timeouts from it.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The public-facing metadata for one environment, field-for-field the Python `to_json()`. */
export interface EnvironmentMeta {
  env_id: string
  display_name: string
  description: string
  min_slots: number
  max_slots: number
  human_slots: string[]
  human_timeout_ms: number | null
  recommended_episode_ticks: number
  pace_interval_ms: number | null
  step_limit_ms: number
  episode_limit_ms: number
  messaging: boolean
  message_cap: number | null
  llm: boolean
  renderer: string
}

/** Thrown when the generated metadata file is missing or does not match the expected shape. */
export class EnvironmentMetadataError extends Error {}

const DEFAULT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'generated', 'environments.json')

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isIntOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function isEnvironmentMeta(value: unknown): value is EnvironmentMeta {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const m = value as Record<string, unknown>
  return (
    typeof m.env_id === 'string' &&
    typeof m.display_name === 'string' &&
    typeof m.description === 'string' &&
    typeof m.min_slots === 'number' &&
    typeof m.max_slots === 'number' &&
    isStringArray(m.human_slots) &&
    isIntOrNull(m.human_timeout_ms) &&
    typeof m.recommended_episode_ticks === 'number' &&
    isIntOrNull(m.pace_interval_ms) &&
    typeof m.step_limit_ms === 'number' &&
    typeof m.episode_limit_ms === 'number' &&
    typeof m.messaging === 'boolean' &&
    isIntOrNull(m.message_cap) &&
    typeof m.llm === 'boolean' &&
    typeof m.renderer === 'string'
  )
}

/** Read-only registry of the environments the backend can launch and serve. */
export class EnvironmentRegistry {
  private readonly byId: Map<string, EnvironmentMeta>

  private constructor(metas: EnvironmentMeta[]) {
    this.byId = new Map(metas.map((meta) => [meta.env_id, meta]))
  }

  /** Parse and validate the generated metadata file, defaulting to the packaged artifact. */
  static load(path: string = DEFAULT_PATH): EnvironmentRegistry {
    let raw: string
    try {
      raw = readFileSync(path, 'utf-8')
    } catch (error) {
      throw new EnvironmentMetadataError(`cannot read environment metadata at ${path}: ${error}`)
    }
    return EnvironmentRegistry.parse(raw, path)
  }

  /** Parse and validate already-read metadata text (the seam tests exercise). */
  static parse(text: string, source = '<memory>'): EnvironmentRegistry {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new EnvironmentMetadataError(
        `environment metadata at ${source} is not valid JSON: ${error}`,
      )
    }
    if (!Array.isArray(parsed)) {
      throw new EnvironmentMetadataError(`environment metadata at ${source} must be a JSON array`)
    }
    const metas: EnvironmentMeta[] = []
    for (const [index, item] of parsed.entries()) {
      if (!isEnvironmentMeta(item)) {
        throw new EnvironmentMetadataError(
          `environment metadata at ${source} entry ${index} has the wrong shape`,
        )
      }
      metas.push(item)
    }
    return new EnvironmentRegistry(metas)
  }

  /** Every environment's metadata, in id order, as served verbatim by the HTTP layer. */
  list(): EnvironmentMeta[] {
    return [...this.byId.values()].sort((a, b) => a.env_id.localeCompare(b.env_id))
  }

  /** One environment's metadata, or `undefined` when no environment has that id. */
  get(envId: string): EnvironmentMeta | undefined {
    return this.byId.get(envId)
  }
}
