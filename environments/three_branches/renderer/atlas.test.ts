import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expectAtlasesFresh } from '@renderers/base/atlas/atlas-io.js'
import { describe, expect, it } from 'vitest'

import { ATLAS_PAGES } from './assets.js'

function pngDimensions(path: string): { width: number; height: number } {
  const bytes = readFileSync(fileURLToPath(new URL(path, import.meta.url)))
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG')
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  }
}

function rendererDirectory(): string {
  const pagePath = ATLAS_PAGES[0]?.pagePath
  if (pagePath === undefined) throw new Error('Three Branches atlas manifest is empty')
  return dirname(dirname(fileURLToPath(new URL(pagePath, import.meta.url))))
}

describe('Three Branches atlas pages', () => {
  it('are fresh from their declared loose frames', async () => {
    await expectAtlasesFresh(rendererDirectory(), ATLAS_PAGES)
  })

  it('have PNG headers matching their declared dimensions', () => {
    for (const page of ATLAS_PAGES) {
      expect(pngDimensions(page.pagePath)).toEqual({
        width: page.width,
        height: page.height,
      })
    }
  })
})
