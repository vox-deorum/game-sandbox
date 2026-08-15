import { Container } from 'pixi.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMOTE_PLATES, USE_PLATE_RECT } from './palette.js'
import { testText } from './test-helpers.js'
import { createVisitorInput, type VisitorInputController } from './visitor-input.js'

const PACE_MS = 250

/** The view point at the middle of a palette plate. */
function plateCenter(rect: { x: number; y: number; width: number; height: number }) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

function emoteRect(token: string) {
  const plate = EMOTE_PLATES.find((candidate) => candidate.token === token)
  if (plate === undefined) throw new Error(`the palette should carry the ${token} plate.`)
  return plate.rect
}

/**
 * Dispatch a synthesized pointer event, the way the shared camera gesture tests do. Defaults to
 * the primary pointer's main (left) button, since that is what every pre-existing call site means.
 */
function pointer(
  target: EventTarget,
  type: string,
  pointerId: number,
  clientX: number,
  clientY: number,
  isPrimary = true,
  button = 0,
  pointerType: 'mouse' | 'touch' | 'pen' = 'mouse',
): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    clientX: { value: clientX },
    clientY: { value: clientY },
    pointerType: { value: pointerType },
    isPrimary: { value: isPrimary },
    button: { value: button },
  })
  target.dispatchEvent(event)
  return event
}

function key(type: 'keydown' | 'keyup', code: string, repeat = false): void {
  window.dispatchEvent(new KeyboardEvent(type, { code, repeat, bubbles: true, cancelable: true }))
}

interface Mounted {
  container: HTMLElement
  surface: HTMLElement
  padLayer: Container
  paletteLayer: Container
  sendAction: ReturnType<typeof vi.fn>
  previewTarget: ReturnType<typeof vi.fn>
  onPreview: ReturnType<typeof vi.fn>
  controller: VisitorInputController
}

describe('Three Branches visitor input', () => {
  const mounted: Mounted[] = []

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    for (const entry of mounted.splice(0)) {
      entry.controller.destroy()
      entry.container.remove()
    }
    vi.useRealTimers()
  })

  function mount(
    overrides: {
      controlledPlayers?: readonly string[]
      sendAction?: ((playerId: string, action: unknown) => void) | undefined
      previewTarget?: () => string | null
    } = {},
  ): Mounted {
    const container = document.createElement('div')
    // Presses land on a child, as they land on the Pixi canvas inside the real host.
    const surface = document.createElement('div')
    container.append(surface)
    document.body.append(container)
    const padLayer = new Container()
    const paletteLayer = new Container()
    const sendAction = vi.fn()
    const previewTarget = vi.fn(overrides.previewTarget ?? ((): string | null => 'stall_0'))
    const onPreview = vi.fn()
    const controller = createVisitorInput({
      container,
      controlledPlayers: overrides.controlledPlayers ?? ['player_0'],
      sendAction: 'sendAction' in overrides ? overrides.sendAction : sendAction,
      paceMs: PACE_MS,
      padLayer,
      paletteLayer,
      createText: testText,
      toView: (client) => ({ x: client.x, y: client.y }),
      currentHeading: () => 45,
      resolution: () => 1,
      previewTarget,
      onPreview,
      redraw: vi.fn(),
    })
    const entry = {
      container,
      surface,
      padLayer,
      paletteLayer,
      sendAction,
      previewTarget,
      onPreview,
      controller,
    }
    mounted.push(entry)
    return entry
  }

  describe('gating', () => {
    it('stays inert without control of player_0', () => {
      const windowListener = vi.spyOn(window, 'addEventListener')
      const { container, surface, sendAction, paletteLayer, padLayer } = mount({
        controlledPlayers: [],
      })
      expect(container.getAttribute('data-three-branches-input')).toBe('none')
      expect(container.getAttribute('data-three-branches-use-button')).toBeNull()
      expect(paletteLayer.children).toHaveLength(0)
      expect(padLayer.children).toHaveLength(0)
      expect(windowListener).not.toHaveBeenCalled()
      key('keydown', 'KeyW')
      pointer(surface, 'pointerdown', 1, 200, 400)
      vi.advanceTimersByTime(PACE_MS * 4)
      expect(sendAction).not.toHaveBeenCalled()
      windowListener.mockRestore()
    })

    it('stays inert without a live sendAction, as spectators and replays mount', () => {
      const windowListener = vi.spyOn(window, 'addEventListener')
      const { container, paletteLayer } = mount({ sendAction: undefined })
      expect(container.getAttribute('data-three-branches-input')).toBe('none')
      expect(paletteLayer.children).toHaveLength(0)
      expect(windowListener).not.toHaveBeenCalled()
      windowListener.mockRestore()
    })

    it('publishes the palette geometry probes while controlled', () => {
      const { container } = mount()
      expect(container.getAttribute('data-three-branches-input')).toBe('ready')
      expect(container.getAttribute('data-three-branches-use-button')).toBe('768,938,96,44')
      expect(container.getAttribute('data-three-branches-emote-wave')).toBe('874,830,96,44')
      expect(container.getAttribute('data-three-branches-emote-shake-head')).toBe('1086,830,96,44')
      expect(container.getAttribute('data-three-branches-queued')).toBe('none')
      expect(container.getAttribute('data-three-branches-last-action')).toBe('none')
      expect(container.getAttribute('data-three-branches-joystick')).toBe('none')
      expect(container.getAttribute('data-three-branches-use-preview')).toBe('none')
    })
  })

  describe('keyboard', () => {
    it('sends held keys once per window at full speed', () => {
      const { container, sendAction } = mount()
      key('keydown', 'KeyW')
      vi.advanceTimersByTime(PACE_MS)
      expect(sendAction).toHaveBeenCalledTimes(1)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 90, speed: 1, action: 0 })
      expect(container.getAttribute('data-three-branches-last-action')).toBe('90,1,0')
      vi.advanceTimersByTime(PACE_MS)
      expect(sendAction).toHaveBeenCalledTimes(2)
    })

    it('halves the speed while Shift is held', () => {
      const { sendAction } = mount()
      key('keydown', 'ShiftLeft')
      key('keydown', 'ArrowRight')
      vi.advanceTimersByTime(PACE_MS)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 0, speed: 0.5, action: 0 })
    })

    it('cancels opposing keys per axis and skips the fully cancelled window', () => {
      const { sendAction } = mount()
      key('keydown', 'KeyW')
      key('keydown', 'KeyS')
      vi.advanceTimersByTime(PACE_MS)
      expect(sendAction).not.toHaveBeenCalled()
      key('keydown', 'KeyD')
      vi.advanceTimersByTime(PACE_MS)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 0, speed: 1, action: 0 })
    })

    it('stops sending once the key lifts', () => {
      const { sendAction } = mount()
      key('keydown', 'KeyA')
      vi.advanceTimersByTime(PACE_MS)
      expect(sendAction).toHaveBeenCalledTimes(1)
      key('keyup', 'KeyA')
      vi.advanceTimersByTime(PACE_MS * 3)
      expect(sendAction).toHaveBeenCalledTimes(1)
    })

    it('drops held keys when the window loses focus', () => {
      const { sendAction } = mount()
      key('keydown', 'KeyD')
      window.dispatchEvent(new Event('blur'))
      vi.advanceTimersByTime(PACE_MS)
      expect(sendAction).not.toHaveBeenCalled()
    })

    it('ignores keys typed into a text field', () => {
      const { sendAction } = mount()
      const field = document.createElement('input')
      document.body.append(field)
      field.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }))
      field.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1', bubbles: true }))
      vi.advanceTimersByTime(PACE_MS)
      expect(sendAction).not.toHaveBeenCalled()
      field.remove()
    })
  })

  describe('joystick', () => {
    it('summons at the press point, drives the drag heading and speed, and stops on release', () => {
      const { container, surface, sendAction } = mount()
      pointer(surface, 'pointerdown', 1, 200, 400)
      expect(container.getAttribute('data-three-branches-joystick')).toBe('200,400')
      pointer(window, 'pointermove', 1, 200, 330)
      vi.advanceTimersByTime(PACE_MS)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 90, speed: 1, action: 0 })
      pointer(window, 'pointerup', 1, 200, 330)
      expect(container.getAttribute('data-three-branches-joystick')).toBe('none')
      vi.advanceTimersByTime(PACE_MS * 3)
      expect(sendAction).toHaveBeenCalledTimes(1)
    })

    it('reads a dead-zone drag as no movement', () => {
      const { surface, sendAction } = mount()
      pointer(surface, 'pointerdown', 1, 200, 400)
      pointer(window, 'pointermove', 1, 205, 400)
      vi.advanceTimersByTime(PACE_MS)
      expect(sendAction).not.toHaveBeenCalled()
    })

    it('saturates at full speed past the pad ring', () => {
      const { surface, sendAction } = mount()
      pointer(surface, 'pointerdown', 1, 200, 400)
      pointer(window, 'pointermove', 1, 200, 900)
      vi.advanceTimersByTime(PACE_MS)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 270, speed: 1, action: 0 })
    })

    it('wins over held keys while engaged', () => {
      const { surface, sendAction } = mount()
      key('keydown', 'KeyS')
      pointer(surface, 'pointerdown', 1, 200, 400)
      pointer(window, 'pointermove', 1, 200, 330)
      vi.advanceTimersByTime(PACE_MS)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 90, speed: 1, action: 0 })
    })

    it('claims left-half presses before the camera gestures and leaves the rest alone', () => {
      const { container, surface } = mount()
      const bubbled = vi.fn()
      container.addEventListener('pointerdown', bubbled)
      pointer(surface, 'pointerdown', 1, 200, 400)
      expect(bubbled).not.toHaveBeenCalled()
      pointer(window, 'pointerup', 1, 200, 400)
      // The right half keeps the camera drag, and the chrome strip keeps its own clicks.
      pointer(surface, 'pointerdown', 2, 700, 400)
      expect(bubbled).toHaveBeenCalledTimes(1)
      pointer(window, 'pointerup', 2, 700, 400)
      pointer(surface, 'pointerdown', 3, 200, 20)
      expect(bubbled).toHaveBeenCalledTimes(2)
    })

    it('does not summon a pad from the right half', () => {
      const { container, surface } = mount()
      pointer(surface, 'pointerdown', 1, 700, 400)
      expect(container.getAttribute('data-three-branches-joystick')).toBe('none')
    })

    it('does not summon or claim a right-button mouse press in the left half', () => {
      const { container, surface } = mount()
      const bubbled = vi.fn()
      container.addEventListener('pointerdown', bubbled)
      // Button 2 (right) on pointerId 1: a mouse's every button shares that pointerId.
      pointer(surface, 'pointerdown', 1, 200, 400, true, 2)
      expect(container.getAttribute('data-three-branches-joystick')).toBe('none')
      expect(bubbled).toHaveBeenCalledTimes(1)
    })

    it('keeps a left-button drag engaged through a right-button press and release on the same pointer', () => {
      const { container, surface, sendAction } = mount()
      pointer(surface, 'pointerdown', 1, 200, 400)
      pointer(window, 'pointermove', 1, 200, 330)
      // The right button rides pointerId 1 too, and must not cancel or stop the engaged drag.
      pointer(surface, 'pointerdown', 1, 200, 400, true, 2)
      pointer(window, 'pointerup', 1, 200, 400, true, 2)
      expect(container.getAttribute('data-three-branches-joystick')).toBe('200,400')
      vi.advanceTimersByTime(PACE_MS)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 90, speed: 1, action: 0 })
    })

    it('does not claim or disturb the drag from a second, non-primary touch pointer', () => {
      const { container, surface, sendAction } = mount()
      const bubbled = vi.fn()
      container.addEventListener('pointerdown', bubbled)
      pointer(surface, 'pointerdown', 1, 200, 400)
      pointer(window, 'pointermove', 1, 200, 330)
      pointer(surface, 'pointerdown', 2, 220, 410, false, 0, 'touch')
      expect(bubbled).toHaveBeenCalledTimes(1)
      expect(container.getAttribute('data-three-branches-joystick')).toBe('200,400')
      vi.advanceTimersByTime(PACE_MS)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 90, speed: 1, action: 0 })
    })

    it('engages and releases the joystick from a primary pen press', () => {
      const { container, surface, sendAction } = mount()
      pointer(surface, 'pointerdown', 1, 200, 400, true, 0, 'pen')
      pointer(window, 'pointermove', 1, 200, 330, true, 0, 'pen')
      expect(container.getAttribute('data-three-branches-joystick')).toBe('200,400')
      vi.advanceTimersByTime(PACE_MS)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 90, speed: 1, action: 0 })
      pointer(window, 'pointerup', 1, 200, 330, true, 0, 'pen')
      expect(container.getAttribute('data-three-branches-joystick')).toBe('none')
    })

    it('claims a left-half double click so it cannot reset the camera', () => {
      const { container, surface } = mount()
      const bubbled = vi.fn()
      container.addEventListener('dblclick', bubbled)
      const left = new MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        clientX: 200,
        clientY: 400,
      })
      surface.dispatchEvent(left)
      expect(bubbled).not.toHaveBeenCalled()
      const right = new MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        clientX: 700,
        clientY: 400,
      })
      surface.dispatchEvent(right)
      expect(bubbled).toHaveBeenCalledTimes(1)
    })
  })

  describe('expression palette', () => {
    it('queues a pressed plate and sends it standing still on the next window', () => {
      const { container, surface, sendAction } = mount()
      const at = plateCenter(emoteRect('wave'))
      pointer(surface, 'pointerdown', 1, at.x, at.y)
      expect(container.getAttribute('data-three-branches-queued')).toBe('wave')
      vi.advanceTimersByTime(PACE_MS)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 45, speed: 0, action: 2 })
      expect(container.getAttribute('data-three-branches-last-action')).toBe('45,0,2')
      expect(container.getAttribute('data-three-branches-queued')).toBe('none')
      vi.advanceTimersByTime(PACE_MS * 2)
      expect(sendAction).toHaveBeenCalledTimes(1)
    })

    it('keeps only the last press in a window', () => {
      const { surface, sendAction } = mount()
      const wave = plateCenter(emoteRect('wave'))
      const sleep = plateCenter(emoteRect('sleep'))
      pointer(surface, 'pointerdown', 1, wave.x, wave.y)
      pointer(window, 'pointerup', 1, wave.x, wave.y)
      pointer(surface, 'pointerdown', 2, sleep.x, sleep.y)
      vi.advanceTimersByTime(PACE_MS)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 45, speed: 0, action: 9 })
    })

    it('sends use from its own plate', () => {
      const { surface, sendAction } = mount()
      const at = plateCenter(USE_PLATE_RECT)
      pointer(surface, 'pointerdown', 1, at.x, at.y)
      vi.advanceTimersByTime(PACE_MS)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 45, speed: 0, action: 1 })
    })

    it('queues from the hotkeys, ignoring auto-repeat', () => {
      const { container, sendAction } = mount()
      key('keydown', 'Digit3')
      expect(container.getAttribute('data-three-branches-queued')).toBe('shake_head')
      vi.advanceTimersByTime(PACE_MS)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 45, speed: 0, action: 4 })
      key('keydown', 'Digit0', true)
      vi.advanceTimersByTime(PACE_MS)
      expect(sendAction).toHaveBeenCalledTimes(1)
      key('keydown', 'Digit0')
      vi.advanceTimersByTime(PACE_MS)
      expect(sendAction).toHaveBeenLastCalledWith('player_0', { heading: 45, speed: 0, action: 1 })
    })

    it('rides a queued expression on the composed motion', () => {
      const { sendAction } = mount()
      key('keydown', 'KeyD')
      key('keydown', 'Digit1')
      vi.advanceTimersByTime(PACE_MS)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 0, speed: 1, action: 2 })
      vi.advanceTimersByTime(PACE_MS)
      expect(sendAction).toHaveBeenLastCalledWith('player_0', { heading: 0, speed: 1, action: 0 })
    })
  })

  describe('use preview', () => {
    it('highlights the selected prop while Use is hovered and clears afterward', () => {
      const { container, surface, onPreview } = mount()
      const at = plateCenter(USE_PLATE_RECT)
      pointer(surface, 'pointermove', 1, at.x, at.y)
      expect(onPreview).toHaveBeenCalledWith('stall_0')
      expect(container.getAttribute('data-three-branches-use-preview')).toBe('stall_0')
      pointer(surface, 'pointermove', 1, 700, 400)
      expect(onPreview).toHaveBeenLastCalledWith(null)
      expect(container.getAttribute('data-three-branches-use-preview')).toBe('none')
    })

    it('shows none when no prop qualifies', () => {
      const { container, surface, onPreview } = mount({ previewTarget: () => null })
      const at = plateCenter(USE_PLATE_RECT)
      pointer(surface, 'pointermove', 1, at.x, at.y)
      expect(onPreview).toHaveBeenCalledWith(null)
      expect(container.getAttribute('data-three-branches-use-preview')).toBe('none')
    })

    it('re-answers the selection when a new frame lands mid-hover', () => {
      const { surface, previewTarget, controller } = mount()
      const at = plateCenter(USE_PLATE_RECT)
      pointer(surface, 'pointermove', 1, at.x, at.y)
      const asked = previewTarget.mock.calls.length
      controller.handleFrame(false)
      expect(previewTarget.mock.calls.length).toBe(asked + 1)
    })
  })

  describe('session end', () => {
    it('stops sending and hides the input UI on the terminal frame', () => {
      const { container, surface, sendAction, paletteLayer, controller } = mount()
      key('keydown', 'KeyW')
      pointer(surface, 'pointerdown', 1, 200, 400)
      controller.handleFrame(true)
      expect(container.getAttribute('data-three-branches-input')).toBe('ended')
      expect(container.getAttribute('data-three-branches-joystick')).toBe('none')
      expect(paletteLayer.visible).toBe(false)
      key('keydown', 'KeyS')
      vi.advanceTimersByTime(PACE_MS * 4)
      expect(sendAction).not.toHaveBeenCalled()
      // The camera keeps the whole content area again: nothing claims the left half anymore.
      const bubbled = vi.fn()
      container.addEventListener('pointerdown', bubbled)
      pointer(surface, 'pointerdown', 2, 200, 400)
      expect(bubbled).toHaveBeenCalledTimes(1)
    })

    it('sends nothing more after destroy', () => {
      const { sendAction, controller } = mount()
      key('keydown', 'KeyW')
      controller.destroy()
      vi.advanceTimersByTime(PACE_MS * 2)
      expect(sendAction).not.toHaveBeenCalled()
    })
  })
})
