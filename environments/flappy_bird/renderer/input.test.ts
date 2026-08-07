import type { RendererContext } from '@renderers/types.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flappyHeader, flappyMeta } from '../../../frontend/test/helpers/fixtures.js'

import { FlappyBirdRenderer } from './index.js'

const META = flappyMeta({ description: '' })
const HEADER = flappyHeader()

function context(overrides: Partial<RendererContext>): RendererContext {
  return {
    container: document.createElement('div'),
    meta: META,
    header: HEADER,
    controlledPlayers: [],
    ...overrides,
  }
}

// The base class wires the device input a renderer declares from `inputs()`: keyboard on `window`,
// pointer/touch on the container (the GPU canvas is absent under jsdom, so the stage element carries
// the pointer listeners). These tests drive that plumbing through the Flappy Bird renderer.
describe('flappy-bird input', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
  })

  it('sends one flap per keydown (Space, ArrowUp, W), ignoring auto-repeat', () => {
    const sendAction = vi.fn()
    const instance = FlappyBirdRenderer.mount(
      context({ container, controlledPlayers: ['player_0'], sendAction }),
    )

    for (const code of ['Space', 'ArrowUp', 'KeyW']) {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, cancelable: true }))
    }
    expect(sendAction).toHaveBeenCalledTimes(3)
    expect(sendAction).toHaveBeenCalledWith('player_0', 1)

    // A held key (repeat) does not flap again.
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', repeat: true }))
    expect(sendAction).toHaveBeenCalledTimes(3)

    // A non-flap key is ignored.
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX' }))
    expect(sendAction).toHaveBeenCalledTimes(3)

    instance.destroy()
  })

  it('sends a flap on pointerdown and touchstart on the stage', () => {
    const sendAction = vi.fn()
    const instance = FlappyBirdRenderer.mount(
      context({ container, controlledPlayers: ['player_0'], sendAction }),
    )
    container.dispatchEvent(new Event('pointerdown', { cancelable: true }))
    container.dispatchEvent(new Event('touchstart', { cancelable: true }))
    expect(sendAction).toHaveBeenCalledTimes(2)
    expect(sendAction).toHaveBeenCalledWith('player_0', 1)
    instance.destroy()
  })

  it('attaches no input when the player is not controlled', () => {
    const sendAction = vi.fn()
    const instance = FlappyBirdRenderer.mount(
      context({ container, controlledPlayers: [], sendAction }),
    )
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }))
    container.dispatchEvent(new Event('pointerdown'))
    expect(sendAction).not.toHaveBeenCalled()
    instance.destroy()
  })

  it('attaches no input when sendAction is absent (spectator / replay)', () => {
    // No throw, every input path inert: this is the draw-only path the replay viewer mounts.
    const instance = FlappyBirdRenderer.mount(
      context({ container, controlledPlayers: ['player_0'] }),
    )
    expect(() =>
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' })),
    ).not.toThrow()
    container.dispatchEvent(new Event('pointerdown'))
    instance.destroy()
  })

  it('removes its listeners on destroy', () => {
    const sendAction = vi.fn()
    const instance = FlappyBirdRenderer.mount(
      context({ container, controlledPlayers: ['player_0'], sendAction }),
    )
    instance.destroy()
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }))
    container.dispatchEvent(new Event('pointerdown'))
    expect(sendAction).not.toHaveBeenCalled()
  })
})
