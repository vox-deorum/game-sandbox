import { describe, expect, it } from 'vitest'

import environmentMetadata from '../../backend/src/environments/generated/environments.json'
import '../src/renderers/index.js'
import { getRenderer, thumbnailFor } from '../src/renderers/registry.js'
import type { RendererDefinition } from '../src/renderers/types.js'

const environmentRendererModules = import.meta.glob<{ default: RendererDefinition }>(
  '../../environments/*/renderer/index.ts',
  { eager: true },
)

describe('renderer registry', () => {
  it('returns the placeholder thumbnail for an unregistered renderer', () => {
    expect(getRenderer('not-registered')).toBeUndefined()
    expect(thumbnailFor('not-registered')).toContain('placeholder.svg')
  })

  it('registers the exported renderer for every generated environment', () => {
    const definitions = Object.values(environmentRendererModules).map((module) => module.default)
    const definitionKeys = definitions.map((definition) => definition.key).sort()
    const metadataKeys = environmentMetadata.map((environment) => environment.renderer).sort()
    expect(definitionKeys).toEqual(metadataKeys)
    for (const definition of definitions) {
      expect(getRenderer(definition.key)).toBe(definition.renderer)
      expect(thumbnailFor(definition.key)).toBe(definition.thumbnail)
    }
  })
})
