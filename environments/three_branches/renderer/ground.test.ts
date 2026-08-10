import type { Container, Texture } from 'pixi.js'
import { describe, expect, it, vi } from 'vitest'

import { withOwnedTextures } from './ground.js'

const texture = (destroy: ReturnType<typeof vi.fn>) => ({ destroy }) as unknown as Texture

describe('Three Branches ground ownership', () => {
  it('destroys its generated solid-color textures exactly once', () => {
    const firstDestroy = vi.fn()
    const secondDestroy = vi.fn()
    const groundDestroy = vi.fn()
    const ground = withOwnedTextures(
      {
        view: {} as Container,
        span: { width: 1, height: 1 },
        setTile: vi.fn(),
        destroy: groundDestroy,
      },
      [texture(firstDestroy), texture(secondDestroy)],
    )

    ground.destroy()
    ground.destroy()

    expect(groundDestroy).toHaveBeenCalledTimes(1)
    expect(firstDestroy).toHaveBeenCalledTimes(1)
    expect(firstDestroy).toHaveBeenCalledWith(true)
    expect(secondDestroy).toHaveBeenCalledTimes(1)
    expect(secondDestroy).toHaveBeenCalledWith(true)
  })
})
