/**
 * Emit the canonical JSON Schema files from the zod definitions under `src/schemas/`.
 *
 * The zod modules are the source of truth. This script renders them to the JSON Schema the Python
 * harness validates against, so a contract change is made once in TypeScript and flows to both sides.
 * `scripts/generate.py` runs it, and the `generated-code-fresh` CI job fails if the committed output
 * has drifted from the schemas.
 *
 * Output is deep key-sorted and written with a trailing newline. Sorting keeps the committed bytes
 * stable no matter what order zod happens to walk the schema in, so a zod upgrade that reorders its
 * internal traversal cannot flap the freshness check.
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { z } from 'zod'

import { EnvironmentMetaSchema } from '../src/schemas/environment.js'
import { RecordingHeaderSchema } from '../src/schemas/recording-header.js'
import { StepStateSchema } from '../src/schemas/step-state.js'

/** The canonical `schema/` directory, two levels above this script. */
const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const BASE_ID = 'https://vox-deorum.github.io/game-sandbox/schema'

/** One emitted file: its zod source and the name it is written under. */
const TARGETS = [
  { filename: 'step-state.schema.json', schema: StepStateSchema },
  { filename: 'recording-header.schema.json', schema: RecordingHeaderSchema },
  { filename: 'environment-meta.schema.json', schema: EnvironmentMetaSchema },
] as const

/** Recursively order object keys, leaving arrays in place because their order is significant. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep)
  }
  if (typeof value !== 'object' || value === null) {
    return value
  }
  const entries = Object.entries(value as Record<string, unknown>)
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return Object.fromEntries(entries.map(([key, nested]) => [key, sortKeysDeep(nested)]))
}

for (const { filename, schema } of TARGETS) {
  // zod sets `$schema` itself; `$id` is ours to assign and is what the harness and the docs cite.
  const emitted = { $id: `${BASE_ID}/${filename}`, ...z.toJSONSchema(schema) }
  const text = `${JSON.stringify(sortKeysDeep(emitted), null, 2)}\n`
  writeFileSync(join(SCHEMA_DIR, filename), text, 'utf-8')
  console.log(`wrote ${filename}`)
}
