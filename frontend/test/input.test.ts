import type { RecordingHeader } from '@game-sandbox/schema'
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { flappyBirdRenderer } from '../src/renderers/flappy-bird/index.js'
import type { RendererContext } from '../src/renderers/types.js'

const META: EnvironmentMeta = {
  env_id: 'flappy_bird',
  display_name: 'Flappy Bird',
  description: '',
  min_slots: 1,
  max_slots: 1,
  human_slots: ['player_0'],
  human_timeout_ms: null,
  recommended_episode_ticks: 1000,
  pace_interval_ms: 50,
  step_limit_ms: 1000,
  episode_limit_ms: 120_000,
  messaging: false,
  message_cap: null,
  llm: false,
  renderer: 'flappy-bird',
}

const HEADER: RecordingHeader = { schema_version: 1, environment: 'flappy_bird', seed: 0 }

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
