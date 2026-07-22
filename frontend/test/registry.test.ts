import { describe, expect, it } from 'vitest'

import environmentMetadata from '../../backend/src/generated/environments.json'
import '../src/renderers/index.js'
import { getRenderer, registerRenderer, thumbnailFor } from '../src/renderers/registry.js'
import type { Renderer, RendererDefinition } from '../src/renderers/types.js'

const environmentRendererModules = import.meta.glob<{ default: RendererDefinition }>(
  '../../environments/src/*/renderer/index.ts',
  { eager: true },
)

const demoRenderer: Renderer = {
  mount: () => ({
    render: () => {},
    destroy: () => {},
    internalSize: { width: 288, height: 512 },
    aspectRatio: 288 / 512,
  }),
}

describe('renderer registry', () => {
  it('returns the placeholder thumbnail for an unregistered renderer', () => {
    expect(getRenderer('not-registered')).toBeUndefined()
    expect(thumbnailFor('not-registered')).toContain('placeholder.svg')
  })

  it('returns the registered renderer and its thumbnail', () => {
    registerRenderer('demo', demoRenderer, 'demo-thumb.svg')
    expect(getRenderer('demo')).toBe(demoRenderer)
    expect(thumbnailFor('demo')).toBe('demo-thumb.svg')
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
