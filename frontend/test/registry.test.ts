import { describe, expect, it, vi } from 'vitest'

import environmentMetadata from '../../backend/src/environments/generated/environments.json'
import '../src/renderers/index.js'
import {
  getRenderer,
  playerNamesFor,
  registerRenderer,
  thumbnailFor,
} from '../src/renderers/registry.js'
import type { Renderer, RendererDefinition } from '../src/renderers/types.js'
import { flappyHeader } from './helpers/fixtures.js'

const environmentRendererModules = import.meta.glob<{ default: RendererDefinition }>(
  '../../environments/*/renderer/index.ts',
  { eager: true },
)

const demoRenderer: Renderer = {
  mount: () => ({
    render: () => Promise.resolve(),
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

  it('returns a registered playerNames function’s map, called with the header passed through', () => {
    const header = flappyHeader()
    let seenHeader: unknown
    registerRenderer('demo-with-names', demoRenderer, 'demo-thumb.svg', (h) => {
      seenHeader = h
      return { player_0: 'Visitor' }
    })
    expect(playerNamesFor('demo-with-names', header)).toEqual({ player_0: 'Visitor' })
    expect(seenHeader).toBe(header)
  })

  it('returns undefined for a renderer registered without a playerNames function', () => {
    registerRenderer('demo-without-names', demoRenderer, 'demo-thumb.svg')
    expect(playerNamesFor('demo-without-names', flappyHeader())).toBeUndefined()
  })

  it('returns undefined for an unregistered key', () => {
    expect(playerNamesFor('not-registered-for-names', flappyHeader())).toBeUndefined()
  })

  it('returns undefined, rather than propagating, when the playerNames function throws', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    registerRenderer('demo-names-throws', demoRenderer, 'demo-thumb.svg', () => {
      throw new Error('cannot name this header')
    })
    expect(playerNamesFor('demo-names-throws', flappyHeader())).toBeUndefined()
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
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
