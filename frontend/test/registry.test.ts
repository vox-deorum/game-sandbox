import { describe, expect, it } from 'vitest'

import { getRenderer, registerRenderer, thumbnailFor } from '../src/renderers/registry.js'
import type { RendererModule } from '../src/renderers/types.js'

const demoModule: RendererModule = {
  mount: () => ({ render: () => {}, destroy: () => {} }),
  thumbnail: 'demo-thumb.png',
  targetCanvasSize: { width: 288, height: 512 },
}

describe('renderer registry', () => {
  it('returns the placeholder thumbnail for an unregistered renderer', () => {
    expect(getRenderer('not-registered')).toBeUndefined()
    expect(thumbnailFor('not-registered')).toContain('data:image/svg+xml')
  })

  it('returns the registered module and its thumbnail', () => {
    registerRenderer('demo', demoModule)
    expect(getRenderer('demo')).toBe(demoModule)
    expect(thumbnailFor('demo')).toBe('demo-thumb.png')
  })
})
