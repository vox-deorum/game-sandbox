/**
 * Docker overlay helpers that can be proven without a daemon. The real build/list paths ride the
 * Docker-gated suite; this file keeps error handling honest with a tiny fake dockerode surface.
 */
import type Docker from 'dockerode'
import { describe, expect, it } from 'vitest'

import { removeImage } from '../src/driver/docker/overlay.js'

function dockerRemoveRejects(error: unknown): Docker {
  return {
    getImage: () => ({
      remove: () => Promise.reject(error),
    }),
  } as unknown as Docker
}

describe('overlay removeImage', () => {
  it('tolerates an image that is already absent', async () => {
    await expect(
      removeImage(dockerRemoveRejects({ statusCode: 404 }), 'overlay:gone'),
    ).resolves.toBeUndefined()
  })

  it('propagates daemon failures so the eviction sweep can log them', async () => {
    const error = Object.assign(new Error('daemon is unhappy'), { statusCode: 500 })

    await expect(removeImage(dockerRemoveRejects(error), 'overlay:stuck')).rejects.toThrow(
      'daemon is unhappy',
    )
  })
})
