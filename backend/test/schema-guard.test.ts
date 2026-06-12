import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * The line-classification rule (a recording line never carries a top-level `kind`; an event
 * envelope always does) depends on the state schema declaring no `kind`. Assert that against the
 * canonical schema so the rule cannot rot silently — if someone ever adds a top-level `kind` to a
 * state, this fails and the classifier must be reconsidered.
 */
const SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'schema',
  'step-state.schema.json',
)

describe('state schema and the classification rule', () => {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8')) as {
    properties?: Record<string, unknown>
    additionalProperties?: boolean
  }

  it('declares no top-level kind property', () => {
    expect(schema.properties).toBeDefined()
    expect(schema.properties).not.toHaveProperty('kind')
  })

  it('forbids unknown top-level properties, so a stray kind could never appear', () => {
    expect(schema.additionalProperties).toBe(false)
  })
})
