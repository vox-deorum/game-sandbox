import { describe, expect, it } from 'vitest'

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

  it('loads every environment renderer through the authoring contract', () => {
    const definitions = Object.values(environmentRendererModules).map((module) => module.default)
    expect(definitions.length).toBeGreaterThan(0)
    expect(new Set(definitions.map((definition) => definition.key)).size).toBe(definitions.length)
    for (const definition of definitions) {
      expect(definition.key).not.toBe('')
      expect(typeof definition.renderer.mount).toBe('function')
      expect(definition.thumbnail).toContain('.svg')
    }
  })
})
