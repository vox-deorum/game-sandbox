import { describe, expect, it } from 'vitest'

import { getRenderer, registerRenderer, thumbnailFor } from '../src/renderers/registry.js'
import type { Renderer } from '../src/renderers/types.js'

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
})
