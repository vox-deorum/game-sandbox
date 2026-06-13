import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { flappyBirdRenderer } from '../src/renderers/flappy-bird/index.js'
import type { RendererContext } from '../src/renderers/types.js'
import { flappyHeader, flappyMeta } from './helpers/fixtures.js'

const META = flappyMeta({ description: '' })
const HEADER = flappyHeader()

function context(overrides: Partial<RendererContext>): RendererContext {
  return {
    container: document.createElement('div'),
    meta: META,
    header: HEADER,
    controlledSlots: [],
    ...overrides,
  }
}

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
    const instance = flappyBirdRenderer.mount(
      context({ container, controlledSlots: ['player_0'], sendAction }),
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

  it('sends a flap on pointerdown and touchstart on the canvas', () => {
    const sendAction = vi.fn()
    const instance = flappyBirdRenderer.mount(
      context({ container, controlledSlots: ['player_0'], sendAction }),
    )
    const canvas = container.querySelector('canvas')
    if (canvas === null) {
      throw new Error('no canvas mounted')
    }
    canvas.dispatchEvent(new Event('pointerdown', { cancelable: true }))
    canvas.dispatchEvent(new Event('touchstart', { cancelable: true }))
    expect(sendAction).toHaveBeenCalledTimes(2)
    instance.destroy()
  })

  it('attaches no input when the slot is not controlled', () => {
    const sendAction = vi.fn()
    const instance = flappyBirdRenderer.mount(
      context({ container, controlledSlots: [], sendAction }),
    )
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }))
    container.querySelector('canvas')?.dispatchEvent(new Event('pointerdown'))
    expect(sendAction).not.toHaveBeenCalled()
    instance.destroy()
  })

  it('attaches no input when sendAction is absent (spectator / replay)', () => {
    const instance = flappyBirdRenderer.mount(context({ container, controlledSlots: ['player_0'] }))
    // No throw, no canvas listeners doing anything: this is the draw-only path.
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }))
    expect(container.querySelector('canvas')).not.toBeNull()
    instance.destroy()
  })

  it('removes its listeners on destroy', () => {
    const sendAction = vi.fn()
    const instance = flappyBirdRenderer.mount(
      context({ container, controlledSlots: ['player_0'], sendAction }),
    )
    instance.destroy()
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }))
    expect(sendAction).not.toHaveBeenCalled()
    expect(container.querySelector('canvas')).toBeNull()
  })
})
