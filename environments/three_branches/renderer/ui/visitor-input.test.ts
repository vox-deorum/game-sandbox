import { Container, Text } from 'pixi.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HEARTHSIDE_STYLE } from '../core/presentation.js'
import { testText } from '../core/test-helpers.js'
import { EMOTE_PLATES, USE_PLATE_RECT } from './palette.js'
import {
  createVisitorInput,
  JOYSTICK_CENTER,
  type VisitorInputController,
} from './visitor-input.js'

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
  targetTransition: ReturnType<typeof vi.fn>
  onPreview: ReturnType<typeof vi.fn>
  controller: VisitorInputController
}

describe('Three Branches visitor input', () => {
  const mounted: Mounted[] = []

  function mount(
    overrides: {
      controlledPlayers?: readonly string[]
      sendAction?: ((playerId: string, action: unknown) => void) | undefined
      previewTarget?: () => string | null
      targetTransition?: (propId: string) => string
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
    const targetTransition = vi.fn(overrides.targetTransition ?? ((): string => 'toggle'))
    const onPreview = vi.fn()
    const controller = createVisitorInput({
      container,
      controlledPlayers: overrides.controlledPlayers ?? ['player_0'],
      sendAction: 'sendAction' in overrides ? overrides.sendAction : sendAction,
      padLayer,
      paletteLayer,
      createText: testText,
      toView: (client) => ({ x: client.x, y: client.y }),
      currentHeading: () => 45,
      resolution: () => 1,
      previewTarget,
      targetTransition,
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
      targetTransition,
      onPreview,
      controller,
    }
    mounted.push(entry)
    return entry
  }

  afterEach(() => {
    vi.useRealTimers()
    for (const entry of mounted.splice(0)) {
      entry.controller.destroy()
      entry.container.remove()
    }
  })

  /** Locate the Use plate's label in the palette layer, for paint assertions. */
  function useLabel(paletteLayer: Container): Text {
    const labels = paletteLayer.children.filter((child): child is Text => child instanceof Text)
    const label = labels.find((node) => node.text === 'Use')
    if (label === undefined) throw new Error('the palette should label the use plate.')
    return label
  }

  describe('gating', () => {
    it('stays inert without control of player_0', () => {
      const windowListener = vi.spyOn(window, 'addEventListener')
      const { container, surface, sendAction, paletteLayer, padLayer, controller } = mount({
        controlledPlayers: [],
      })
      expect(container.getAttribute('data-three-branches-input')).toBe('none')
      expect(container.getAttribute('data-three-branches-use-button')).toBeNull()
      expect(paletteLayer.children).toHaveLength(0)
      expect(padLayer.children).toHaveLength(0)
      expect(windowListener).not.toHaveBeenCalled()
      key('keydown', 'KeyW')
      pointer(surface, 'pointerdown', 1, 200, 400)
      controller.handleFrame(false)
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
      const { container, padLayer } = mount()
      expect(container.getAttribute('data-three-branches-input')).toBe('ready')
      expect(container.getAttribute('data-three-branches-use-button')).toBe('608,930,136,52')
      expect(container.getAttribute('data-three-branches-emote-wave')).toBe('754,806,136,52')
      expect(container.getAttribute('data-three-branches-emote-shake-head')).toBe('1046,806,136,52')
      expect(container.getAttribute('data-three-branches-queued')).toBe('none')
      expect(container.getAttribute('data-three-branches-last-action')).toBe('none')
      expect(container.getAttribute('data-three-branches-joystick')).toBe('88,912')
      expect(container.getAttribute('data-three-branches-use-preview')).toBe('none')
      expect(container.getAttribute('data-three-branches-use-latch')).toBe('none')
      expect(padLayer.children).toHaveLength(1)
      expect(padLayer.visible).toBe(true)
    })
  })

  describe('keyboard', () => {
    it('sends held keys once per landed frame at full speed', () => {
      const { container, sendAction, controller } = mount()
      key('keydown', 'KeyW')
      // Motion now also pushes eagerly on input, and again on every landed frame.
      expect(sendAction).toHaveBeenCalledTimes(1)
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledTimes(2)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 90, speed: 1, action: 0 })
      expect(container.getAttribute('data-three-branches-last-action')).toBe('90,1,0')
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledTimes(3)
    })

    it('halves the speed while Shift is held', () => {
      const { sendAction, controller } = mount()
      key('keydown', 'ShiftLeft')
      key('keydown', 'ArrowRight')
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 0, speed: 0.5, action: 0 })
    })

    it('cancels opposing keys per axis and skips the fully cancelled frame', () => {
      const { sendAction, controller } = mount()
      key('keydown', 'KeyW')
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 90, speed: 1, action: 0 })
      key('keydown', 'KeyS')
      // The axes cancel, so the change reads as an explicit stop of the in-flight motion.
      expect(sendAction).toHaveBeenLastCalledWith('player_0', { heading: 45, speed: 0, action: 0 })
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledTimes(2)
      key('keydown', 'KeyD')
      expect(sendAction).toHaveBeenCalledTimes(3)
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 0, speed: 1, action: 0 })
      expect(sendAction).toHaveBeenCalledTimes(4)
    })

    it('stops sending once the key lifts', () => {
      const { sendAction, controller } = mount()
      key('keydown', 'KeyA')
      expect(sendAction).toHaveBeenCalledTimes(1)
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledTimes(2)
      key('keyup', 'KeyA')
      // The lift sends an explicit stop at the current heading.
      expect(sendAction).toHaveBeenLastCalledWith('player_0', { heading: 45, speed: 0, action: 0 })
      controller.handleFrame(false)
      controller.handleFrame(false)
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledTimes(3)
    })

    it('drops held keys when the window loses focus', () => {
      const { sendAction, controller } = mount()
      key('keydown', 'KeyD')
      expect(sendAction).toHaveBeenCalledTimes(1)
      window.dispatchEvent(new Event('blur'))
      // Losing focus drops the keys, so the in-flight motion is stopped explicitly.
      expect(sendAction).toHaveBeenLastCalledWith('player_0', { heading: 45, speed: 0, action: 0 })
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledTimes(2)
    })

    it('ignores keys typed into a text field', () => {
      const { sendAction, controller } = mount()
      const field = document.createElement('input')
      document.body.append(field)
      field.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }))
      field.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1', bubbles: true }))
      controller.handleFrame(false)
      expect(sendAction).not.toHaveBeenCalled()
      field.remove()
    })
  })

  describe('joystick', () => {
    it('stays at the bottom left, drives a drag, and returns to idle on release', () => {
      const { container, surface, sendAction, controller } = mount()
      expect(container.getAttribute('data-three-branches-joystick')).toBe('88,912')
      pointer(surface, 'pointerdown', 1, JOYSTICK_CENTER.x, JOYSTICK_CENTER.y)
      // Engaging inside the dead zone moves nothing, so nothing sends yet.
      expect(sendAction).not.toHaveBeenCalled()
      pointer(window, 'pointermove', 1, JOYSTICK_CENTER.x, JOYSTICK_CENTER.y - 70)
      expect(sendAction).toHaveBeenCalledTimes(1)
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledTimes(2)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 90, speed: 1, action: 0 })
      pointer(window, 'pointerup', 1, JOYSTICK_CENTER.x, JOYSTICK_CENTER.y - 70)
      expect(container.getAttribute('data-three-branches-joystick')).toBe('88,912')
      // Release sends an explicit stop on top of the motion sends.
      expect(sendAction).toHaveBeenLastCalledWith('player_0', { heading: 45, speed: 0, action: 0 })
      controller.handleFrame(false)
      controller.handleFrame(false)
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledTimes(3)
    })

    it('claims only the fixed pad and leaves the rest of the left side to the camera', () => {
      const { container, surface } = mount()
      const bubbled = vi.fn()
      container.addEventListener('pointerdown', bubbled)
      pointer(surface, 'pointerdown', 1, JOYSTICK_CENTER.x, JOYSTICK_CENTER.y)
      expect(bubbled).not.toHaveBeenCalled()
      pointer(window, 'pointerup', 1, JOYSTICK_CENTER.x, JOYSTICK_CENTER.y)
      pointer(surface, 'pointerdown', 2, 200, 400)
      expect(bubbled).toHaveBeenCalledTimes(1)
      pointer(window, 'pointerup', 2, 200, 400)
      pointer(surface, 'pointerdown', 3, 200, 20)
      expect(bubbled).toHaveBeenCalledTimes(2)
    })

    it('does not engage from outside the fixed pad', () => {
      const { container, surface, sendAction, controller } = mount()
      pointer(surface, 'pointerdown', 1, 200, 400)
      pointer(window, 'pointermove', 1, 200, 330)
      controller.handleFrame(false)
      expect(container.getAttribute('data-three-branches-joystick')).toBe('88,912')
      expect(sendAction).not.toHaveBeenCalled()
    })

    it('does not engage or claim a right-button mouse press on the pad', () => {
      const { container, surface } = mount()
      const bubbled = vi.fn()
      container.addEventListener('pointerdown', bubbled)
      // Button 2 (right) on pointerId 1: a mouse's every button shares that pointerId.
      pointer(surface, 'pointerdown', 1, JOYSTICK_CENTER.x, JOYSTICK_CENTER.y, true, 2)
      expect(container.getAttribute('data-three-branches-joystick')).toBe('88,912')
      expect(bubbled).toHaveBeenCalledTimes(1)
    })

    it('keeps a left-button drag engaged through a right-button press and release on the same pointer', () => {
      const { surface, sendAction, controller } = mount()
      pointer(surface, 'pointerdown', 1, JOYSTICK_CENTER.x, JOYSTICK_CENTER.y)
      pointer(window, 'pointermove', 1, JOYSTICK_CENTER.x, JOYSTICK_CENTER.y - 70)
      // The right button rides pointerId 1 too, and must not cancel or stop the engaged drag.
      pointer(surface, 'pointerdown', 1, JOYSTICK_CENTER.x, JOYSTICK_CENTER.y, true, 2)
      pointer(window, 'pointerup', 1, JOYSTICK_CENTER.x, JOYSTICK_CENTER.y, true, 2)
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 90, speed: 1, action: 0 })
    })

    it('does not claim or disturb the drag from a second, non-primary touch pointer', () => {
      const { container, surface, sendAction, controller } = mount()
      const bubbled = vi.fn()
      container.addEventListener('pointerdown', bubbled)
      pointer(surface, 'pointerdown', 1, JOYSTICK_CENTER.x, JOYSTICK_CENTER.y)
      pointer(window, 'pointermove', 1, JOYSTICK_CENTER.x, JOYSTICK_CENTER.y - 70)
      pointer(
        surface,
        'pointerdown',
        2,
        JOYSTICK_CENTER.x + 20,
        JOYSTICK_CENTER.y,
        false,
        0,
        'touch',
      )
      expect(bubbled).toHaveBeenCalledTimes(1)
      expect(container.getAttribute('data-three-branches-joystick')).toBe('88,912')
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 90, speed: 1, action: 0 })
    })

    it('engages and releases the joystick from a primary pen press', () => {
      const { container, surface, sendAction, controller } = mount()
      pointer(surface, 'pointerdown', 1, JOYSTICK_CENTER.x, JOYSTICK_CENTER.y, true, 0, 'pen')
      pointer(window, 'pointermove', 1, JOYSTICK_CENTER.x, JOYSTICK_CENTER.y - 70, true, 0, 'pen')
      expect(container.getAttribute('data-three-branches-joystick')).toBe('88,912')
      expect(sendAction).toHaveBeenCalledTimes(1)
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 90, speed: 1, action: 0 })
      pointer(window, 'pointerup', 1, JOYSTICK_CENTER.x, JOYSTICK_CENTER.y - 70, true, 0, 'pen')
      expect(container.getAttribute('data-three-branches-joystick')).toBe('88,912')
      // Release sends an explicit stop on top of the motion sends.
      expect(sendAction).toHaveBeenCalledTimes(3)
    })

    it('claims a pad double click and leaves other left-side double clicks to the camera', () => {
      const { container, surface } = mount()
      const bubbled = vi.fn()
      container.addEventListener('dblclick', bubbled)
      const pad = new MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        clientX: JOYSTICK_CENTER.x,
        clientY: JOYSTICK_CENTER.y,
      })
      surface.dispatchEvent(pad)
      expect(bubbled).not.toHaveBeenCalled()
      const outside = new MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        clientX: 200,
        clientY: 400,
      })
      surface.dispatchEvent(outside)
      expect(bubbled).toHaveBeenCalledTimes(1)
    })
  })

  describe('expression palette', () => {
    it('queues a pressed plate and sends it standing still on the next landed frame', () => {
      const { container, surface, sendAction, controller } = mount()
      const at = plateCenter(emoteRect('wave'))
      pointer(surface, 'pointerdown', 1, at.x, at.y)
      expect(container.getAttribute('data-three-branches-queued')).toBe('wave')
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 45, speed: 0, action: 2 })
      expect(container.getAttribute('data-three-branches-last-action')).toBe('45,0,2')
      expect(container.getAttribute('data-three-branches-queued')).toBe('none')
      controller.handleFrame(false)
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledTimes(1)
    })

    it('keeps only the last press in a window', () => {
      const { surface, sendAction, controller } = mount()
      const wave = plateCenter(emoteRect('wave'))
      const sleep = plateCenter(emoteRect('sleep'))
      pointer(surface, 'pointerdown', 1, wave.x, wave.y)
      pointer(window, 'pointerup', 1, wave.x, wave.y)
      pointer(surface, 'pointerdown', 2, sleep.x, sleep.y)
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 45, speed: 0, action: 9 })
    })

    it('sends use once from its own plate when the target toggles after one flip', () => {
      const { surface, sendAction, controller } = mount()
      const at = plateCenter(USE_PLATE_RECT)
      pointer(surface, 'pointerdown', 1, at.x, at.y)
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 45, speed: 0, action: 1 })
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledTimes(1)
    })

    it('queues from the hotkeys, ignoring auto-repeat', () => {
      const { container, sendAction, controller } = mount()
      key('keydown', 'Digit3')
      expect(container.getAttribute('data-three-branches-queued')).toBe('shake_head')
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 45, speed: 0, action: 4 })
      key('keydown', 'Digit0', true)
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledTimes(1)
      key('keydown', 'Digit0')
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenLastCalledWith('player_0', { heading: 45, speed: 0, action: 1 })
    })

    it('rides a queued expression on the composed motion', () => {
      const { sendAction, controller } = mount()
      key('keydown', 'KeyD')
      key('keydown', 'Digit1')
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 0, speed: 1, action: 2 })
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenLastCalledWith('player_0', { heading: 0, speed: 1, action: 0 })
    })
  })

  describe('use latch', () => {
    it('holds use on an occupancy prop across landed frames', () => {
      const { container, surface, sendAction, controller } = mount({
        previewTarget: () => 'bench_0',
        targetTransition: (id) => (id === 'bench_0' ? 'occupancy' : 'toggle'),
      })
      const at = plateCenter(USE_PLATE_RECT)
      pointer(surface, 'pointerdown', 1, at.x, at.y)
      expect(container.getAttribute('data-three-branches-use-latch')).toBe('bench_0')
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenLastCalledWith('player_0', { heading: 45, speed: 0, action: 1 })
      expect(container.getAttribute('data-three-branches-use-latch')).toBe('bench_0')
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledTimes(2)
      expect(sendAction).toHaveBeenLastCalledWith('player_0', { heading: 45, speed: 0, action: 1 })
    })

    it('toggles the latch off on a second Use press', () => {
      const { container, surface, sendAction, controller } = mount({
        previewTarget: () => 'bench_0',
        targetTransition: () => 'occupancy',
      })
      const at = plateCenter(USE_PLATE_RECT)
      pointer(surface, 'pointerdown', 1, at.x, at.y)
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledTimes(1)
      pointer(surface, 'pointerdown', 2, at.x, at.y)
      expect(container.getAttribute('data-three-branches-use-latch')).toBe('none')
      controller.handleFrame(false)
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledTimes(1)
    })

    it('releases the latch when an emote is pressed', () => {
      const { container, surface, sendAction, controller } = mount({
        previewTarget: () => 'bench_0',
        targetTransition: () => 'occupancy',
      })
      const use = plateCenter(USE_PLATE_RECT)
      pointer(surface, 'pointerdown', 1, use.x, use.y)
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledTimes(1)
      const wave = plateCenter(emoteRect('wave'))
      pointer(surface, 'pointerdown', 2, wave.x, wave.y)
      expect(container.getAttribute('data-three-branches-use-latch')).toBe('none')
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenLastCalledWith('player_0', { heading: 45, speed: 0, action: 2 })
    })

    it('releases the latch when movement begins', () => {
      const { container, sendAction, controller } = mount({
        previewTarget: () => 'bench_0',
        targetTransition: () => 'occupancy',
      })
      key('keydown', 'Digit0')
      expect(container.getAttribute('data-three-branches-use-latch')).toBe('bench_0')
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledTimes(1)
      key('keydown', 'KeyW')
      controller.handleFrame(false)
      expect(container.getAttribute('data-three-branches-use-latch')).toBe('none')
      expect(sendAction).toHaveBeenLastCalledWith('player_0', { heading: 90, speed: 1, action: 0 })
    })

    it('releases the latch when the landed frame reports no preview target', () => {
      let target: string | null = 'bench_0'
      const { container, surface, sendAction, controller } = mount({
        previewTarget: () => target,
        targetTransition: () => 'occupancy',
      })
      const at = plateCenter(USE_PLATE_RECT)
      pointer(surface, 'pointerdown', 1, at.x, at.y)
      expect(container.getAttribute('data-three-branches-use-latch')).toBe('bench_0')
      // The visitor then walks out of reach, so the landing pose no longer resolves any prop.
      target = null
      controller.handleFrame(false)
      expect(container.getAttribute('data-three-branches-use-latch')).toBe('none')
      expect(sendAction).not.toHaveBeenCalled()
    })

    it('releases a none-transition latch after its first send', () => {
      const { container, surface, sendAction, controller } = mount({
        previewTarget: () => 'board_0',
        targetTransition: () => 'none',
      })
      const at = plateCenter(USE_PLATE_RECT)
      pointer(surface, 'pointerdown', 1, at.x, at.y)
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 45, speed: 0, action: 1 })
      expect(container.getAttribute('data-three-branches-use-latch')).toBe('none')
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledTimes(1)
    })

    it('does not latch a Use press while no prop is in reach', () => {
      const { container, surface, sendAction, controller } = mount({ previewTarget: () => null })
      const at = plateCenter(USE_PLATE_RECT)
      pointer(surface, 'pointerdown', 1, at.x, at.y)
      expect(container.getAttribute('data-three-branches-use-latch')).toBe('none')
      controller.handleFrame(false)
      expect(sendAction).not.toHaveBeenCalled()
    })

    it('keeps a queued emote when a Use press finds no prop in reach', () => {
      const { container, surface, sendAction, controller } = mount({ previewTarget: () => null })
      const wave = plateCenter(emoteRect('wave'))
      pointer(surface, 'pointerdown', 1, wave.x, wave.y)
      expect(container.getAttribute('data-three-branches-queued')).toBe('wave')
      const at = plateCenter(USE_PLATE_RECT)
      pointer(surface, 'pointerdown', 2, at.x, at.y)
      expect(container.getAttribute('data-three-branches-use-latch')).toBe('none')
      expect(container.getAttribute('data-three-branches-queued')).toBe('wave')
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 45, speed: 0, action: 2 })
    })
  })

  describe('use while moving', () => {
    it('ignores a Use press and paints the plate dim while moving', () => {
      const { container, surface, paletteLayer, sendAction, controller } = mount()
      key('keydown', 'KeyW')
      const at = plateCenter(USE_PLATE_RECT)
      pointer(surface, 'pointerdown', 1, at.x, at.y)
      expect(container.getAttribute('data-three-branches-use-latch')).toBe('none')
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 90, speed: 1, action: 0 })
      expect(useLabel(paletteLayer).alpha).toBeLessThan(1)
    })

    it('ignores the use hotkey while moving', () => {
      const { container, sendAction, controller } = mount()
      key('keydown', 'KeyW')
      key('keydown', 'Digit0')
      expect(container.getAttribute('data-three-branches-use-latch')).toBe('none')
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 90, speed: 1, action: 0 })
    })

    it('paints the latched Use plate with the gilt active treatment', () => {
      const { paletteLayer } = mount({
        previewTarget: () => 'bench_0',
        targetTransition: () => 'occupancy',
      })
      key('keydown', 'Digit0')
      expect(useLabel(paletteLayer).style.fill).toBe(HEARTHSIDE_STYLE.palette.ink)
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
      const { container, surface, sendAction, padLayer, paletteLayer, controller } = mount()
      key('keydown', 'KeyW')
      pointer(surface, 'pointerdown', 1, JOYSTICK_CENTER.x, JOYSTICK_CENTER.y)
      controller.handleFrame(true)
      expect(container.getAttribute('data-three-branches-input')).toBe('ended')
      expect(container.getAttribute('data-three-branches-joystick')).toBe('none')
      expect(padLayer.visible).toBe(false)
      expect(paletteLayer.visible).toBe(false)
      key('keydown', 'KeyS')
      controller.handleFrame(false)
      controller.handleFrame(false)
      controller.handleFrame(false)
      // Only the pre-terminal sends remain: the eager KeyW motion, and the stop sent when the
      // joystick engages in its dead zone, because an engaged joystick overrides the held key.
      expect(sendAction).toHaveBeenCalledTimes(2)
      // The camera keeps the whole content area again: nothing claims the left half anymore.
      const bubbled = vi.fn()
      container.addEventListener('pointerdown', bubbled)
      pointer(surface, 'pointerdown', 2, 200, 400)
      expect(bubbled).toHaveBeenCalledTimes(1)
    })

    it('sends nothing more after destroy', () => {
      const { sendAction, controller } = mount()
      key('keydown', 'KeyW')
      expect(sendAction).toHaveBeenCalledTimes(1)
      controller.destroy()
      controller.handleFrame(false)
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledTimes(1)
    })

    it('ends the session on a terminal snap frame without sending', () => {
      const { container, padLayer, paletteLayer, sendAction, controller } = mount()
      key('keydown', 'KeyW')
      controller.handleFrame(true, false)
      expect(container.getAttribute('data-three-branches-input')).toBe('ended')
      expect(container.getAttribute('data-three-branches-joystick')).toBe('none')
      expect(padLayer.visible).toBe(false)
      expect(paletteLayer.visible).toBe(false)
      expect(sendAction).toHaveBeenCalledTimes(1)
    })

    it('skips the send window on a non-terminal snap frame but stays live', () => {
      const { container, sendAction, controller } = mount()
      key('keydown', 'KeyW')
      expect(sendAction).toHaveBeenCalledTimes(1)
      controller.handleFrame(false, false)
      expect(container.getAttribute('data-three-branches-input')).toBe('ready')
      expect(sendAction).toHaveBeenCalledTimes(1)
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledTimes(2)
    })
  })

  describe('eager motion and heartbeat', () => {
    it('sends motion eagerly before any landed frame', () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
      const { sendAction } = mount()
      key('keydown', 'KeyW')
      expect(sendAction).toHaveBeenCalledTimes(1)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 90, speed: 1, action: 0 })
      vi.useRealTimers()
    })

    it('sends an explicit stop on release and on blur', () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
      const { sendAction } = mount()
      key('keydown', 'KeyW')
      key('keyup', 'KeyW')
      expect(sendAction).toHaveBeenCalledTimes(2)
      expect(sendAction).toHaveBeenLastCalledWith('player_0', { heading: 45, speed: 0, action: 0 })
      key('keydown', 'KeyD')
      window.dispatchEvent(new Event('blur'))
      expect(sendAction).toHaveBeenCalledTimes(4)
      expect(sendAction).toHaveBeenLastCalledWith('player_0', { heading: 45, speed: 0, action: 0 })
      vi.useRealTimers()
    })

    it('dedupes unchanged motion and throttles distinct motion to one send per 50 ms', () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
      const { surface, sendAction } = mount()
      const north = { x: JOYSTICK_CENTER.x, y: JOYSTICK_CENTER.y - 70 }
      const east = { x: JOYSTICK_CENTER.x + 70, y: JOYSTICK_CENTER.y }
      const south = { x: JOYSTICK_CENTER.x, y: JOYSTICK_CENTER.y + 70 }
      pointer(surface, 'pointerdown', 1, JOYSTICK_CENTER.x, JOYSTICK_CENTER.y)
      expect(sendAction).not.toHaveBeenCalled()
      pointer(window, 'pointermove', 1, north.x, north.y)
      expect(sendAction).toHaveBeenCalledTimes(1)
      expect(sendAction).toHaveBeenLastCalledWith('player_0', { heading: 90, speed: 1, action: 0 })
      // A distinct heading inside the throttle window is dropped.
      vi.advanceTimersByTime(10)
      pointer(window, 'pointermove', 1, east.x, east.y)
      expect(sendAction).toHaveBeenCalledTimes(1)
      // Once the window has passed, a distinct heading sends again.
      vi.advanceTimersByTime(50)
      pointer(window, 'pointermove', 1, south.x, south.y)
      expect(sendAction).toHaveBeenCalledTimes(2)
      // The same key as the latest send is deduped again, no time window needed.
      pointer(window, 'pointermove', 1, south.x, south.y)
      expect(sendAction).toHaveBeenCalledTimes(2)
      vi.useRealTimers()
    })

    it('heartbeat re-sends the held motion while motion is held', () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
      const { sendAction } = mount()
      key('keydown', 'KeyW')
      expect(sendAction).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(220)
      expect(sendAction).toHaveBeenCalledTimes(3)
      expect(sendAction).toHaveBeenLastCalledWith('player_0', { heading: 90, speed: 1, action: 0 })
      expect(sendAction).not.toHaveBeenCalledWith('player_0', { heading: 45, speed: 0, action: 0 })
      vi.useRealTimers()
    })

    it('keeps expressions exactly once while walking', () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
      const { sendAction, controller } = mount()
      key('keydown', 'KeyW')
      key('keydown', 'Digit1')
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledTimes(2)
      // The heartbeat is suppressed while the queued emote is in flight.
      vi.advanceTimersByTime(300)
      expect(sendAction).toHaveBeenCalledTimes(2)
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledTimes(3)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 90, speed: 1, action: 2 })
      vi.useRealTimers()
    })

    it('does not send a stop after a stop (blur twice)', () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
      const { sendAction } = mount()
      key('keydown', 'KeyD')
      expect(sendAction).toHaveBeenCalledTimes(1)
      window.dispatchEvent(new Event('blur'))
      expect(sendAction).toHaveBeenCalledTimes(2)
      window.dispatchEvent(new Event('blur'))
      expect(sendAction).toHaveBeenCalledTimes(2)
      vi.useRealTimers()
    })

    it('clears the heartbeat on the terminal frame and on destroy', () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
      const first = mount()
      key('keydown', 'KeyW')
      expect(first.sendAction).toHaveBeenCalledTimes(1)
      first.controller.handleFrame(true)
      vi.advanceTimersByTime(500)
      expect(first.sendAction).toHaveBeenCalledTimes(1)
      const second = mount()
      key('keydown', 'KeyW')
      expect(second.sendAction).toHaveBeenCalledTimes(1)
      second.controller.destroy()
      vi.advanceTimersByTime(500)
      expect(second.sendAction).toHaveBeenCalledTimes(1)
      vi.useRealTimers()
    })

    it('re-sends the same motion eagerly after release during an expression flight', () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
      const { sendAction, controller } = mount()
      key('keydown', 'KeyW')
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 90, speed: 1, action: 0 })
      key('keydown', 'Digit1')
      // The frozen frame carries the motion and the queued emote together.
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledTimes(2)
      expect(sendAction).toHaveBeenLastCalledWith('player_0', { heading: 90, speed: 1, action: 2 })
      key('keyup', 'KeyW')
      // The release is suppressed while the emote is in flight, so no stop sends yet.
      expect(sendAction).toHaveBeenCalledTimes(2)
      // The flight clears and nothing composes, so the recorded motion drops at rest.
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledTimes(2)
      // A fresh start re-sends eagerly instead of deduping against the stale pre-flight key.
      key('keydown', 'KeyW')
      expect(sendAction).toHaveBeenCalledTimes(3)
      expect(sendAction).toHaveBeenLastCalledWith('player_0', { heading: 90, speed: 1, action: 0 })
      vi.useRealTimers()
    })

    it('does not re-send a stop after an idle frame', () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
      const { sendAction, controller } = mount()
      key('keydown', 'Digit1')
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledWith('player_0', { heading: 45, speed: 0, action: 2 })
      // The next frame clears the flight and sends nothing, leaving the visitor at rest.
      controller.handleFrame(false)
      expect(sendAction).toHaveBeenCalledTimes(1)
      // Shift alone reads no motion, and with no motion recorded it must send nothing.
      key('keydown', 'ShiftLeft')
      expect(sendAction).toHaveBeenCalledTimes(1)
      vi.useRealTimers()
    })
  })
})
