import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expectAtlasesFresh } from '@renderers/base/atlas/atlas-io.js'
import { describe, it } from 'vitest'

import { ATLAS_PAGES } from './assets.js'

function rendererDirectory(): string {
  const pagePath = ATLAS_PAGES[0]?.pagePath
  if (pagePath === undefined) throw new Error('Three Branches atlas manifest is empty')
  return dirname(dirname(fileURLToPath(new URL(pagePath, import.meta.url))))
}

describe('Three Branches atlas pages', () => {
  it('are fresh from their declared loose frames', async () => {
    await expectAtlasesFresh(rendererDirectory(), ATLAS_PAGES)
  })
})
